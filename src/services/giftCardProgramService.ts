import { FastifyInstance } from "fastify";
import { EntityManager } from "typeorm";
import { GiftCardProgram } from "../entities/gift-card-program";
import { BadRequestError, ConflictError, NotFoundError } from "../errors";
import { currencyExponent } from "../gift-cards/money";
import {
  ProgramDefinitionInput,
  ProgramPatch,
  validateProgramDefinition,
  validateProgramUpdate,
} from "../gift-cards/program-rules";
import { writeAudit } from "./audit";

export type CreateProgramInput = ProgramDefinitionInput;
export type UpdateProgramInput = ProgramPatch;

export interface CallerContext {
  tenantId: string;
  userId: string;
}

export interface ProgramResponse {
  id: string;
  name: string;
  cardType: GiftCardProgram["cardType"];
  currency: string;
  currencyExponent: number;
  country: string;
  region: string | null;
  cardNumberPrefix: string;
  cardNumberLength: number;
  pinRequired: boolean;
  maxValue: number;
  expiryMonths: number | null;
  staffDailyIssueLimit: number | null;
  status: GiftCardProgram["status"];
  hasIssuedCards: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function toProgramResponse(p: GiftCardProgram, hasIssuedCards: boolean): ProgramResponse {
  const exponent = currencyExponent(p.currency);
  // Unreachable through the API (currency is validated); fail loud rather than invent an exponent
  if (exponent === null) throw new Error("program has an unsupported currency");
  return {
    id: p.id,
    name: p.name,
    cardType: p.cardType,
    currency: p.currency,
    currencyExponent: exponent,
    country: p.country,
    region: p.region,
    cardNumberPrefix: p.cardNumberPrefix,
    cardNumberLength: p.cardNumberLength,
    pinRequired: p.pinRequired,
    maxValue: p.maxValue,
    expiryMonths: p.expiryMonths,
    staffDailyIssueLimit: p.staffDailyIssueLimit,
    status: p.status,
    hasIssuedCards,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export class GiftCardProgramService {
  constructor(private app: FastifyInstance) {}

  /** The tenant always comes from the caller's token, never from the request body. */
  async createProgram(ctx: CallerContext, input: CreateProgramInput): Promise<ProgramResponse> {
    const result = validateProgramDefinition(input);
    if (!result.ok) throw new BadRequestError(result.problems.join("; "));

    return this.app.db.transaction("READ COMMITTED", async (em) => {
      const program = await em.save(
        em.create(GiftCardProgram, { ...result.value, tenantId: ctx.tenantId, status: "active" })
      );
      await writeAudit(em, ctx, { action: "gift_card_program.created", details: { programId: program.id } });
      // A program that was just created has no cards
      return toProgramResponse(program, false);
    });
  }

  async listPrograms(tenantId: string): Promise<ProgramResponse[]> {
    const programs = await this.app.db
      .getRepository(GiftCardProgram)
      .find({ where: { tenantId }, order: { createdAt: "ASC", id: "ASC" } });
    const withCards = await this.programIdsWithCards(
      this.app.db.manager,
      programs.map((p) => p.id)
    );
    return programs.map((p) => toProgramResponse(p, withCards.has(p.id)));
  }

  async getProgram(tenantId: string, id: string): Promise<ProgramResponse> {
    const program = await this.app.db.getRepository(GiftCardProgram).findOneBy({ id, tenantId });
    if (!program) throw new NotFoundError("Program not found");
    const withCards = await this.programIdsWithCards(this.app.db.manager, [id]);
    return toProgramResponse(program, withCards.has(id));
  }

  /**
   * Locks the program FOR UPDATE, then checks whether a card exists. Issue takes FOR SHARE on the
   * same row, so an update and a first issue serialize whichever comes first (design 7.4).
   */
  async updateProgram(ctx: CallerContext, id: string, patch: UpdateProgramInput): Promise<ProgramResponse> {
    return this.app.db.transaction("READ COMMITTED", async (em) => {
      const current = await em.findOne(GiftCardProgram, {
        where: { id, tenantId: ctx.tenantId },
        lock: { mode: "pessimistic_write" },
      });
      if (!current) throw new NotFoundError("Program not found");

      const hasIssuedCards = (await this.programIdsWithCards(em, [id])).has(id);
      const result = validateProgramUpdate(current, patch, hasIssuedCards);
      if (!result.ok) {
        if (result.immutableFields.length > 0) {
          throw new ConflictError(`Cannot change once cards are issued: ${result.immutableFields.join(", ")}`);
        }
        throw new BadRequestError(result.problems.join("; "));
      }

      const changed: Record<string, unknown> = {};
      for (const c of result.changes) changed[c.field] = c.to;
      await em.update(GiftCardProgram, { id, tenantId: ctx.tenantId }, changed);
      await writeAudit(em, ctx, {
        action: "gift_card_program.updated",
        details: { programId: id, changes: result.changes },
      });

      const updated = await em.findOneByOrFail(GiftCardProgram, { id, tenantId: ctx.tenantId });
      return toProgramResponse(updated, hasIssuedCards);
    });
  }

  /** Which of `ids` have at least one card. Uses the program_id index per id. */
  private async programIdsWithCards(em: EntityManager, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows: { id: string }[] = await em.query(
      `SELECT p.id FROM unnest($1::uuid[]) AS p(id)
        WHERE EXISTS (SELECT 1 FROM gift_cards c WHERE c.program_id = p.id)`,
      [ids]
    );
    return new Set(rows.map((r) => r.id));
  }
}
