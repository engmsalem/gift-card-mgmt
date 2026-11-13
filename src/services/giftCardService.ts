import { FastifyInstance } from "fastify";
import { EntityManager } from "typeorm";
import { assertValidEmail, normalizeEmail } from "../credentials";
import type { GiftCardDeliveryStatus } from "../entities/gift-card-delivery";
import type { GiftCardStatus } from "../entities/gift-card";
import type { GiftCardTransactionType } from "../entities/gift-card-transaction";
import { Role } from "../enums/roles";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors";
import type { CardCrypto } from "../gift-cards/card-crypto";
import { generateCardNumber, generatePin, generateReferenceNumber, normalizeReferenceNumber } from "../gift-cards/card-number";
import {
  Caller,
  CardSnapshot,
  Rejection,
  TransitionDecision,
  decideIssue,
  decideResume,
  decideSuspend,
  decideVoid,
  effectiveStatus,
} from "../gift-cards/card-state";
import { currencyExponent } from "../gift-cards/money";
import type { CardType, ProgramStatus } from "../gift-cards/program-rules";
import { requestHashIssue } from "../gift-cards/request-hash";
import { writeAudit } from "./audit";
import type { DeliveryDispatcher } from "./deliveryDispatcher";
import type { CallerContext } from "./giftCardProgramService";
import { returningRows, uniqueViolationConstraint } from "./sql";

export interface IssueContext extends CallerContext {
  role: Role;
}

export interface IssueInput {
  programId: string;
  amount: number;
  idempotencyKey: string;
  recipient: { name: string; email: string };
  senderName: string;
  message?: string;
  sendAt?: string;
}

export interface GiftCardResponse {
  id: string;
  programId: string;
  referenceNumber: string;
  last4: string;
  currency: string;
  currencyExponent: number;
  initialAmount: number;
  balance: number;
  status: GiftCardStatus;
  hasPin: boolean;
  expiresAt: Date | null;
  pinLocked: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface GiftCardDeliveryResponse {
  id: string;
  recipientName: string;
  recipientEmail: string;
  senderName: string;
  message: string | null;
  sendAt: Date;
  status: GiftCardDeliveryStatus;
  attempts: number;
  sentAt: Date | null;
  openedAt: Date | null;
  revealCount: number;
  lastRevealedAt: Date | null;
}

export interface CardWithDelivery {
  card: GiftCardResponse;
  delivery: GiftCardDeliveryResponse;
}

export interface IssueResult extends CardWithDelivery {
  /** True when the idempotency key had already issued this exact request. */
  replayed: boolean;
}

export interface TransactionResponse {
  id: string;
  giftCardId: string;
  type: GiftCardTransactionType;
  amount: number;
  currency: string;
  balanceAfter: number;
  relatedTransactionId: string | null;
  externalReference: string | null;
  actorUserId: string;
  createdAt: Date;
}

export const IDEMPOTENCY_CONSTRAINT = "gift_card_transactions_tenant_id_idempotency_key_key";
// A generated number or reference that lost a race against another issue; a retry draws new ones
const GENERATION_CONSTRAINTS = ["gift_cards_card_number_hmac_key", "gift_cards_tenant_id_reference_number_key"];
const MAX_ISSUE_ATTEMPTS = 3;
const MAX_GENERATION_ATTEMPTS = 5;
const MAX_SEND_AHEAD_DAYS = 365;

// Every card column the API exposes, plus the flags computed from the DB clock. Never the number,
// PIN, ciphertexts, HMAC or key ids.
export const CARD_COLUMNS = `c.id, c.program_id, c.reference_number, c.card_number_last4, c.currency,
  c.initial_amount, c.balance, c.status, c.expires_at, c.created_at, c.updated_at,
  (c.pin_enc IS NOT NULL) AS has_pin,
  (c.pin_locked_until IS NOT NULL AND c.pin_locked_until > now()) AS pin_locked,
  (c.expires_at IS NOT NULL AND c.expires_at <= now()) AS is_expired`;

const DELIVERY_COLUMNS = `id, recipient_name, recipient_email, sender_name, message, send_at, status,
  attempts, sent_at, opened_at, reveal_count, last_revealed_at`;

export interface CardRow {
  id: string;
  program_id: string;
  reference_number: string;
  card_number_last4: string;
  currency: string;
  initial_amount: number;
  balance: number;
  status: GiftCardStatus;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  has_pin: boolean;
  pin_locked: boolean;
  is_expired: boolean;
}

interface DeliveryRow {
  id: string;
  recipient_name: string;
  recipient_email: string;
  sender_name: string;
  message: string | null;
  send_at: Date;
  status: GiftCardDeliveryStatus;
  attempts: number;
  sent_at: Date | null;
  opened_at: Date | null;
  reveal_count: number;
  last_revealed_at: Date | null;
}

interface ProgramRow {
  id: string;
  currency: string;
  card_type: CardType;
  card_number_prefix: string;
  card_number_length: number;
  pin_required: boolean;
  max_value: number;
  expiry_months: number | null;
  staff_daily_issue_limit: number | null;
  status: ProgramStatus;
}

export interface TransactionRow {
  id: string;
  gift_card_id: string;
  type: GiftCardTransactionType;
  amount: number;
  currency: string;
  balance_after: number;
  related_transaction_id: string | null;
  external_reference: string | null;
  actor_user_id: string;
  created_at: Date;
}

export function toCardResponse(r: CardRow): GiftCardResponse {
  const exponent = currencyExponent(r.currency);
  // Unreachable: programs only accept supported currencies; fail loud rather than invent an exponent
  if (exponent === null) throw new Error("card has an unsupported currency");
  return {
    id: r.id,
    programId: r.program_id,
    referenceNumber: r.reference_number,
    last4: r.card_number_last4,
    currency: r.currency,
    currencyExponent: exponent,
    initialAmount: r.initial_amount,
    balance: r.balance,
    status: effectiveStatus({ status: r.status, isExpired: r.is_expired }),
    hasPin: r.has_pin,
    expiresAt: r.expires_at,
    pinLocked: r.pin_locked,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toDeliveryResponse(r: DeliveryRow): GiftCardDeliveryResponse {
  return {
    id: r.id,
    recipientName: r.recipient_name,
    recipientEmail: r.recipient_email,
    senderName: r.sender_name,
    message: r.message,
    sendAt: r.send_at,
    status: r.status,
    attempts: r.attempts,
    sentAt: r.sent_at,
    openedAt: r.opened_at,
    revealCount: r.reveal_count,
    lastRevealedAt: r.last_revealed_at,
  };
}

/** The delivery of a card. Issue creates it in the same transaction as the card, so it always exists. */
export async function loadDelivery(em: EntityManager, tenantId: string, cardId: string): Promise<GiftCardDeliveryResponse> {
  const [delivery] = await returningRows<DeliveryRow>(
    em,
    `SELECT ${DELIVERY_COLUMNS} FROM gift_card_deliveries WHERE gift_card_id = $1 AND tenant_id = $2`,
    [cardId, tenantId]
  );
  if (!delivery) throw new Error("gift card has no delivery");
  return toDeliveryResponse(delivery);
}

export function toTransactionResponse(r: TransactionRow): TransactionResponse {
  return {
    id: r.id,
    giftCardId: r.gift_card_id,
    type: r.type,
    amount: r.amount,
    currency: r.currency,
    balanceAfter: r.balance_after,
    relatedTransactionId: r.related_transaction_id,
    externalReference: r.external_reference,
    actorUserId: r.actor_user_id,
    createdAt: r.created_at,
  };
}

export function snapshot(r: CardRow): CardSnapshot {
  return { status: r.status, balance: r.balance, isExpired: r.is_expired };
}

export function rejectionError(reason: Rejection): ConflictError {
  return new ConflictError(reason === "expired" ? "Card has expired" : "Card is not active");
}

/** Same idempotency key, different request. */
export function idempotencyConflict(): ConflictError {
  return new ConflictError("Idempotency key already used with a different request");
}

export class GiftCardService {
  constructor(
    private app: FastifyInstance,
    private cardCrypto: CardCrypto,
    private dispatcher: DeliveryDispatcher
  ) {}

  // ---------- issue ----------

  /**
   * Issues a card (design 6.2). One READ COMMITTED transaction: program FOR SHARE, the staff
   * advisory lock, the idempotency read, the rules, the card, its `issue` ledger row, the delivery
   * and the audit row. The delivery is dispatched only after the commit.
   */
  async issue(ctx: IssueContext, input: IssueInput): Promise<IssueResult> {
    const recipientEmail = normalizeEmail(input.recipient.email);
    assertValidEmail(recipientEmail);
    const requestHash = requestHashIssue({
      actorUserId: ctx.userId,
      programId: input.programId,
      amount: input.amount,
      recipientEmail,
      recipientName: input.recipient.name,
      senderName: input.senderName,
      message: input.message,
      sendAt: input.sendAt,
    });
    const prepared = { recipientEmail, requestHash };

    const result = await this.issueWithRetries(ctx, input, prepared);
    // A replay changes nothing, so there is nothing to send
    if (result.replayed) return result;
    await this.dispatcher.dispatch({ deliveryId: result.delivery.id });
    // Dispatch may have sent it (or failed, or left it scheduled for later): report the real status
    const delivery = await loadDelivery(this.app.db.manager, ctx.tenantId, result.card.id);
    return { ...result, delivery };
  }

  private async issueWithRetries(
    ctx: IssueContext,
    input: IssueInput,
    prepared: { recipientEmail: string; requestHash: Buffer }
  ): Promise<IssueResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.app.db.transaction("READ COMMITTED", (em) =>
          this.issueInTransaction(em, ctx, input, prepared)
        );
      } catch (err) {
        // After rollback: the transaction is over, so a read here cannot hit an aborted transaction
        const constraint = uniqueViolationConstraint(err);
        if (constraint === IDEMPOTENCY_CONSTRAINT) {
          // A concurrent request with this key committed first (an admin double-submit, or the key
          // reused across actors)
          return this.replayAfterRollback(ctx.tenantId, input.idempotencyKey, prepared.requestHash, err);
        }
        if (constraint !== null && GENERATION_CONSTRAINTS.includes(constraint)) {
          if (attempt < MAX_ISSUE_ATTEMPTS) continue;
          // A bare 23505 would be mapped to 409; this is a server-side failure
          throw new Error("could not issue a card with a unique number and reference", { cause: err });
        }
        throw err;
      }
    }
  }

  private async issueInTransaction(
    em: EntityManager,
    ctx: IssueContext,
    input: IssueInput,
    prepared: { recipientEmail: string; requestHash: Buffer }
  ): Promise<IssueResult> {
    // 1. Lock the program so a concurrent program update serializes with this issue
    const [program] = await returningRows<ProgramRow>(
      em,
      `SELECT id, currency, card_type, card_number_prefix, card_number_length, pin_required, max_value,
              expiry_months, staff_daily_issue_limit, status
         FROM gift_card_programs WHERE id = $1 AND tenant_id = $2 FOR SHARE`,
      [input.programId, ctx.tenantId]
    );
    if (!program) throw new NotFoundError("Program not found");

    // 2. Staff only: serialize this user's issues in this program, before the idempotency read, so a
    // concurrent same-key retry waits here and then replays
    const caller: Caller = ctx.role === Role.ADMIN ? "admin" : "staff";
    if (caller === "staff") {
      await em.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [
        `gift-card-issue:${program.id}:${ctx.userId}`,
      ]);
    }

    // 3. Idempotency
    const existing = await this.findIdempotentTransaction(em, ctx.tenantId, input.idempotencyKey);
    if (existing) {
      if (!existing.request_hash || !existing.request_hash.equals(prepared.requestHash)) {
        throw idempotencyConflict();
      }
      return { replayed: true, ...(await this.loadCardAndDelivery(em, ctx.tenantId, existing.gift_card_id)) };
    }

    // 4. Rules
    const decision = decideIssue(
      {
        status: program.status,
        cardType: program.card_type,
        maxValue: program.max_value,
        staffDailyIssueLimit: program.staff_daily_issue_limit,
      },
      caller,
      input.amount
    );
    if (!decision.ok) {
      switch (decision.reason) {
        case "program_retired":
          throw new ConflictError("Program is retired");
        case "promotional_requires_admin":
          throw new ForbiddenError("Only an admin can issue promotional cards");
        case "amount_above_max":
          throw new BadRequestError("Amount is above the program maximum");
        case "no_staff_limit":
          throw new ForbiddenError("Staff cannot issue cards from this program");
      }
    }
    if (decision.staffLimit !== null) {
      const [cap] = await returningRows<{ ok: boolean }>(
        em,
        `SELECT COALESCE(SUM(t.amount), 0) + $4::int <= $5::int AS ok
           FROM gift_card_transactions t JOIN gift_cards c ON c.id = t.gift_card_id
          WHERE t.tenant_id = $1 AND t.actor_user_id = $2 AND t.type = 'issue'
            AND c.program_id = $3 AND t.created_at > now() - interval '24 hours'`,
        [ctx.tenantId, ctx.userId, program.id, input.amount, decision.staffLimit]
      );
      if (!cap.ok) throw new ForbiddenError("Daily staff issue limit reached");
    }

    // 5. Id first: the encryption AAD binds the ciphertext to it
    const [{ id: cardId }] = await returningRows<{ id: string }>(em, `SELECT uuidv7() AS id`);

    // 6. Number, PIN and reference (unique), encrypted
    const secrets = await this.generateSecrets(em, program, ctx.tenantId, cardId);

    // 7. Card
    await returningRows(
      em,
      `INSERT INTO gift_cards (id, tenant_id, program_id, currency, reference_number, card_number_enc,
          card_number_hmac, card_number_last4, pin_enc, encryption_key_id, lookup_key_id, initial_amount,
          balance, status, expires_at, issued_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, 'active',
          CASE WHEN $13::int IS NULL THEN NULL ELSE now() + make_interval(months => $13::int) END, $14)`,
      [
        cardId,
        ctx.tenantId,
        program.id,
        program.currency,
        secrets.reference,
        secrets.numberEnc,
        secrets.numberHmac,
        secrets.last4,
        secrets.pinEnc,
        this.cardCrypto.encryptionKeyId,
        this.cardCrypto.lookupKeyId,
        input.amount,
        program.expiry_months,
        ctx.userId,
      ]
    );

    // 8. Ledger
    await returningRows(
      em,
      `INSERT INTO gift_card_transactions (tenant_id, gift_card_id, currency, type, amount, balance_after,
          idempotency_key, request_hash, actor_user_id)
       VALUES ($1, $2, $3, 'issue', $4, $4, $5, $6, $7)`,
      [ctx.tenantId, cardId, program.currency, input.amount, input.idempotencyKey, prepared.requestHash, ctx.userId]
    );

    // 9. Delivery
    const sendAt = input.sendAt === undefined ? null : new Date(input.sendAt).toISOString();
    const [window] = await returningRows<{ ok: boolean }>(
      em,
      `SELECT ($1::timestamptz IS NULL OR $1::timestamptz <= now() + make_interval(days => $2::int)) AS ok`,
      [sendAt, MAX_SEND_AHEAD_DAYS]
    );
    if (!window.ok) throw new BadRequestError(`sendAt must be within ${MAX_SEND_AHEAD_DAYS} days`);
    await returningRows(
      em,
      `INSERT INTO gift_card_deliveries (tenant_id, gift_card_id, recipient_name, recipient_email, sender_name,
          message, send_at, status, next_attempt_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()), 'scheduled',
          COALESCE($7::timestamptz, now()), $8)`,
      [
        ctx.tenantId,
        cardId,
        input.recipient.name,
        prepared.recipientEmail,
        input.senderName,
        input.message ?? null,
        sendAt,
        ctx.userId,
      ]
    );

    // 10. Audit (the caller commits)
    await writeAudit(em, ctx, {
      action: "gift_card.issued",
      details: { giftCardId: cardId, programId: program.id, amount: input.amount },
    });

    return { replayed: false, ...(await this.loadCardAndDelivery(em, ctx.tenantId, cardId)) };
  }

  /** Generates a number and reference that are not taken yet (up to 5 draws), and encrypts the secrets. */
  private async generateSecrets(em: EntityManager, program: ProgramRow, tenantId: string, cardId: string) {
    for (let draw = 0; draw < MAX_GENERATION_ATTEMPTS; draw++) {
      const number = generateCardNumber(program.card_number_prefix, program.card_number_length);
      const reference = generateReferenceNumber();
      const numberHmac = this.cardCrypto.lookupHash(number);
      const [taken] = await returningRows<{ number_taken: boolean; reference_taken: boolean }>(
        em,
        `SELECT EXISTS (SELECT 1 FROM gift_cards WHERE card_number_hmac = $1) AS number_taken,
                EXISTS (SELECT 1 FROM gift_cards WHERE tenant_id = $2 AND reference_number = $3) AS reference_taken`,
        [numberHmac, tenantId, reference]
      );
      if (taken.number_taken || taken.reference_taken) continue;

      const ids = { tenantId, cardId };
      const pin = program.pin_required ? generatePin() : null;
      return {
        reference,
        numberHmac,
        last4: number.slice(-4),
        numberEnc: this.cardCrypto.encrypt("number", ids, number),
        pinEnc: pin === null ? null : this.cardCrypto.encrypt("pin", ids, pin),
      };
    }
    throw new Error("could not generate a unique card number");
  }

  /** Outside any transaction: what the winner of a concurrent same-key issue left behind. */
  private async replayAfterRollback(
    tenantId: string,
    idempotencyKey: string,
    requestHash: Buffer,
    cause: unknown
  ): Promise<IssueResult> {
    const existing = await this.findIdempotentTransaction(this.app.db.manager, tenantId, idempotencyKey);
    if (!existing) {
      // The conflicting row vanished (the ledger is append-only, so this should not happen); a bare
      // 23505 would be mapped to 409, so raise a plain error for the 500 path
      throw new Error("idempotency re-read found no row", { cause });
    }
    if (!existing.request_hash || !existing.request_hash.equals(requestHash)) throw idempotencyConflict();
    return {
      replayed: true,
      ...(await this.loadCardAndDelivery(this.app.db.manager, tenantId, existing.gift_card_id)),
    };
  }

  private async findIdempotentTransaction(em: EntityManager, tenantId: string, idempotencyKey: string) {
    const [row] = await returningRows<{ gift_card_id: string; request_hash: Buffer | null }>(
      em,
      `SELECT gift_card_id, request_hash FROM gift_card_transactions
        WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey]
    );
    return row;
  }

  // ---------- reads ----------

  async getCard(tenantId: string, id: string): Promise<CardWithDelivery> {
    return this.loadCardAndDelivery(this.app.db.manager, tenantId, id);
  }

  async getCardByReference(tenantId: string, reference: string): Promise<CardWithDelivery> {
    const normalized = normalizeReferenceNumber(reference);
    if (normalized === null) throw new NotFoundError("Gift card not found");
    const [row] = await returningRows<{ id: string }>(
      this.app.db.manager,
      `SELECT id FROM gift_cards WHERE tenant_id = $1 AND reference_number = $2`,
      [tenantId, normalized]
    );
    if (!row) throw new NotFoundError("Gift card not found");
    return this.loadCardAndDelivery(this.app.db.manager, tenantId, row.id);
  }

  async listTransactions(tenantId: string, id: string): Promise<TransactionResponse[]> {
    const em = this.app.db.manager;
    const [card] = await returningRows<{ id: string }>(
      em,
      `SELECT id FROM gift_cards WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    if (!card) throw new NotFoundError("Gift card not found");
    const rows = await returningRows<TransactionRow>(
      em,
      `SELECT id, gift_card_id, type, amount, currency, balance_after, related_transaction_id,
              external_reference, actor_user_id, created_at
         FROM gift_card_transactions WHERE gift_card_id = $1 AND tenant_id = $2
        ORDER BY created_at, id`,
      [id, tenantId]
    );
    return rows.map(toTransactionResponse);
  }

  // ---------- admin state changes (design 7.5) ----------

  /** Suspending a suspended card succeeds without a change. */
  suspend(ctx: CallerContext, id: string): Promise<CardWithDelivery> {
    return this.changeStatus(ctx, id, decideSuspend, "suspended", "gift_card.suspended");
  }

  /** Resuming an active card succeeds without a change. */
  resume(ctx: CallerContext, id: string): Promise<CardWithDelivery> {
    return this.changeStatus(ctx, id, decideResume, "active", "gift_card.resumed");
  }

  /**
   * Voids the card from any status: a `void` ledger row for the remaining balance (only if above 0),
   * balance 0, and the pending delivery cancelled with its token cleared. Voiding a voided card
   * succeeds without a change.
   */
  async void(ctx: CallerContext, id: string): Promise<CardWithDelivery> {
    return this.app.db.transaction("READ COMMITTED", async (em) => {
      const card = await this.lockCard(em, ctx.tenantId, id);
      const decision = decideVoid({ status: card.status, balance: card.balance });
      if (decision.changed) {
        if (decision.voidedAmount > 0) {
          await returningRows(
            em,
            `INSERT INTO gift_card_transactions (tenant_id, gift_card_id, currency, type, amount, balance_after,
                actor_user_id)
             VALUES ($1, $2, $3, 'void', $4, 0, $5)`,
            [ctx.tenantId, id, card.currency, decision.voidedAmount, ctx.userId]
          );
        }
        await em.query(
          `UPDATE gift_cards SET balance = 0, status = 'voided', updated_at = now()
            WHERE id = $1 AND tenant_id = $2`,
          [id, ctx.tenantId]
        );
        await em.query(
          `UPDATE gift_card_deliveries SET status = 'cancelled', claimed_at = NULL, token_hash = NULL,
              token_expires_at = NULL, updated_at = now()
            WHERE gift_card_id = $1 AND tenant_id = $2 AND status <> 'cancelled'`,
          [id, ctx.tenantId]
        );
        await writeAudit(em, ctx, {
          action: "gift_card.voided",
          details: { giftCardId: id, voidedAmount: decision.voidedAmount },
        });
      }
      return this.loadCardAndDelivery(em, ctx.tenantId, id);
    });
  }

  /** Clears the PIN lockout in any status, and always writes the audit row. */
  async unlock(ctx: CallerContext, id: string): Promise<CardWithDelivery> {
    return this.app.db.transaction("READ COMMITTED", async (em) => {
      await this.lockCard(em, ctx.tenantId, id);
      await em.query(
        `UPDATE gift_cards SET failed_pin_attempts = 0, pin_locked_until = NULL, updated_at = now()
          WHERE id = $1 AND tenant_id = $2`,
        [id, ctx.tenantId]
      );
      await writeAudit(em, ctx, { action: "gift_card.unlocked", details: { giftCardId: id } });
      return this.loadCardAndDelivery(em, ctx.tenantId, id);
    });
  }

  private async changeStatus(
    ctx: CallerContext,
    id: string,
    decide: (card: CardSnapshot) => TransitionDecision,
    newStatus: "active" | "suspended",
    action: "gift_card.suspended" | "gift_card.resumed"
  ): Promise<CardWithDelivery> {
    return this.app.db.transaction("READ COMMITTED", async (em) => {
      const card = await this.lockCard(em, ctx.tenantId, id);
      const decision = decide(snapshot(card));
      if (!decision.ok) throw rejectionError(decision.reason);
      if (decision.changed) {
        await em.query(`UPDATE gift_cards SET status = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2`, [
          id,
          ctx.tenantId,
          newStatus,
        ]);
        await writeAudit(em, ctx, { action, details: { giftCardId: id } });
      }
      return this.loadCardAndDelivery(em, ctx.tenantId, id);
    });
  }

  // ---------- shared ----------

  private async lockCard(em: EntityManager, tenantId: string, id: string): Promise<CardRow> {
    const [card] = await returningRows<CardRow>(
      em,
      `SELECT ${CARD_COLUMNS} FROM gift_cards c WHERE c.id = $1 AND c.tenant_id = $2 FOR UPDATE`,
      [id, tenantId]
    );
    if (!card) throw new NotFoundError("Gift card not found");
    return card;
  }

  private async loadCardAndDelivery(em: EntityManager, tenantId: string, cardId: string): Promise<CardWithDelivery> {
    const [card] = await returningRows<CardRow>(
      em,
      `SELECT ${CARD_COLUMNS} FROM gift_cards c WHERE c.id = $1 AND c.tenant_id = $2`,
      [cardId, tenantId]
    );
    if (!card) throw new NotFoundError("Gift card not found");
    return { card: toCardResponse(card), delivery: await loadDelivery(em, tenantId, cardId) };
  }
}
