import { FastifyInstance } from "fastify";
import { EntityManager } from "typeorm";
import { ConflictError, NotFoundError } from "../errors";
import type { CardCrypto } from "../gift-cards/card-crypto";
import { normalizeCardNumber } from "../gift-cards/card-number";
import {
  CARD_EXPIRED_MESSAGE,
  CARD_NOT_ACTIVE_MESSAGE,
  INSUFFICIENT_BALANCE_MESSAGE,
  PIN_LOCK_MINUTES,
  decidePinAttempt,
  decideRedeem,
  decideRefund,
} from "../gift-cards/card-state";
import { requestHashRedeem, requestHashRefund } from "../gift-cards/request-hash";
import { writeAudit } from "./audit";
import type { CallerContext } from "./giftCardProgramService";
import {
  CARD_COLUMNS,
  CardRow,
  GiftCardResponse,
  IDEMPOTENCY_CONSTRAINT,
  TransactionResponse,
  TransactionRow,
  findCard,
  idempotencyConflict,
  rejectionError,
  snapshot,
  toCardResponse,
  toTransactionResponse,
} from "./giftCardService";
import { returningRows, uniqueViolationConstraint } from "./sql";

/** Shown for every authentication failure, so the response never says which part was wrong. */
export const CARD_AUTH_FAILED = "Invalid card number or PIN";

/**
 * Unknown or unnormalizable number, wrong or missing PIN, or a locked card. The route logs it
 * (design 6.1 step 7); the message and status are identical for every cause.
 */
export class CardAuthFailedError extends NotFoundError {
  constructor() {
    super(CARD_AUTH_FAILED);
  }
}

export interface LookupInput {
  cardNumber: string;
  pin?: string;
}

export interface RedeemInput extends LookupInput {
  amount: number;
  idempotencyKey: string;
  externalReference?: string;
}

export interface RefundInput {
  amount: number;
  idempotencyKey: string;
}

export interface TransactionResult {
  /** True when the idempotency key had already recorded this exact request. */
  replayed: boolean;
  transaction: TransactionResponse;
  card: GiftCardResponse;
}

// A card the caller has authenticated, plus what the PIN check needs
interface AuthenticatedCardRow extends CardRow {
  pin_enc: Buffer | null;
  encryption_key_id: number;
  failed_pin_attempts: number;
}

type KeyedTransactionRow = TransactionRow & { request_hash: Buffer | null };

// Decided inside the transaction and turned into an error only after it commits, so the PIN counter
// and the expiry write persist even though the request fails (design 6, "commit then throw")
type RedeemOutcome =
  | { kind: "done"; result: TransactionResult }
  | { kind: "auth_failed" | "idempotency_conflict" | "expired" | "not_active" | "insufficient_balance" };

const TRANSACTION_COLUMNS = `id, gift_card_id, type, amount, currency, balance_after, related_transaction_id,
  external_reference, actor_user_id, created_at`;

function throwFor(outcome: Exclude<RedeemOutcome, { kind: "done" }>): never {
  switch (outcome.kind) {
    case "auth_failed":
      throw new CardAuthFailedError();
    case "idempotency_conflict":
      throw idempotencyConflict();
    case "expired":
      throw new ConflictError(CARD_EXPIRED_MESSAGE);
    case "not_active":
      throw new ConflictError(CARD_NOT_ACTIVE_MESSAGE);
    case "insufficient_balance":
      throw new ConflictError(INSUFFICIENT_BALANCE_MESSAGE);
  }
}

export class RedemptionService {
  constructor(
    private app: FastifyInstance,
    private cardCrypto: CardCrypto,
    // Bounds every wait on a card row (and on a conflicting unique key); an integer count of
    // milliseconds, because SET LOCAL takes no bind parameter
    private lockTimeoutMs: number
  ) {
    if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
      throw new Error("lockTimeoutMs must be a positive integer");
    }
  }

  // ---------- lookup ----------

  /** Authenticates the card (counting a wrong PIN) and returns it. Never changes the card's status. */
  async lookup(ctx: CallerContext, input: LookupInput): Promise<{ card: GiftCardResponse }> {
    const number = normalizeCardNumber(input.cardNumber);
    if (number === null) throw new CardAuthFailedError();
    const hmac = this.cardCrypto.lookupHash(number);

    const card = await this.inTransaction(async (em) => {
      const authenticated = await this.authenticate(em, ctx, hmac, input.pin);
      return authenticated === null ? null : this.loadCard(em, ctx.tenantId, authenticated.id);
    });
    if (card === null) throw new CardAuthFailedError();
    return { card };
  }

  // ---------- redeem (design 6.1) ----------

  async redeem(ctx: CallerContext, input: RedeemInput): Promise<TransactionResult> {
    const number = normalizeCardNumber(input.cardNumber);
    if (number === null) throw new CardAuthFailedError();
    const hmac = this.cardCrypto.lookupHash(number);
    const requestHash = requestHashRedeem({ hmac, amount: input.amount, externalReference: input.externalReference });

    let outcome: RedeemOutcome;
    try {
      outcome = await this.inTransaction((em) => this.redeemInTransaction(em, ctx, input, hmac, requestHash));
    } catch (err) {
      return this.recoverIdempotencyRace(err, ctx.tenantId, input.idempotencyKey, requestHash);
    }
    if (outcome.kind !== "done") throwFor(outcome);
    return outcome.result;
  }

  private async redeemInTransaction(
    em: EntityManager,
    ctx: CallerContext,
    input: RedeemInput,
    hmac: Buffer,
    requestHash: Buffer
  ): Promise<RedeemOutcome> {
    // 1. Lock and authenticate. Everything below is reachable only for an authenticated card, so no
    // card-dependent answer (replay, conflict, balance) can confirm that a number exists
    const card = await this.authenticate(em, ctx, hmac, input.pin);
    if (card === null) return { kind: "auth_failed" };

    // 2. Idempotency, before any mutable rule
    const existing = await this.findByKey(em, ctx.tenantId, input.idempotencyKey);
    if (existing) {
      if (!existing.request_hash || !existing.request_hash.equals(requestHash)) {
        return { kind: "idempotency_conflict" };
      }
      return { kind: "done", result: await this.replayOf(em, ctx.tenantId, existing) };
    }

    // 3. Rules
    const decision = decideRedeem(snapshot(card), input.amount);
    if (!decision.ok) {
      if (decision.reason === "expired") {
        await em.query(
          `UPDATE gift_cards SET status = 'expired', updated_at = now()
            WHERE id = $1 AND tenant_id = $2 AND status <> 'expired'`,
          [card.id, ctx.tenantId]
        );
      }
      return { kind: decision.reason };
    }

    // 4. Balance. The card row is locked, so the conditions always hold; they keep the write
    // correct on its own if the lock were ever missing
    const [updated] = await returningRows<{ balance: number }>(
      em,
      `UPDATE gift_cards
          SET balance = balance - $3::int,
              status = CASE WHEN balance - $3::int = 0 THEN 'depleted' ELSE status END,
              updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND status = 'active' AND balance >= $3::int
          AND (expires_at IS NULL OR expires_at > now())
    RETURNING balance`,
      [card.id, ctx.tenantId, input.amount]
    );
    if (!updated) throw new Error("redeem matched no card row under the row lock");

    // 5. Ledger
    const [transaction] = await returningRows<TransactionRow>(
      em,
      `INSERT INTO gift_card_transactions (tenant_id, gift_card_id, currency, type, amount, balance_after,
          idempotency_key, request_hash, external_reference, actor_user_id)
       VALUES ($1, $2, $3, 'redeem', $4, $5, $6, $7, $8, $9)
    RETURNING ${TRANSACTION_COLUMNS}`,
      [
        ctx.tenantId,
        card.id,
        card.currency,
        input.amount,
        updated.balance,
        input.idempotencyKey,
        requestHash,
        input.externalReference ?? null,
        ctx.userId,
      ]
    );
    return {
      kind: "done",
      result: {
        replayed: false,
        transaction: toTransactionResponse(transaction),
        card: await this.loadCard(em, ctx.tenantId, card.id),
      },
    };
  }

  // ---------- refund (design 7.5) ----------

  /**
   * Credits back part or all of a redemption. The total refunded for one redemption never exceeds
   * what it took. Currency and tenant of the new ledger row are enforced by the composite FK.
   */
  async refund(ctx: CallerContext, transactionId: string, input: RefundInput): Promise<TransactionResult> {
    const requestHash = requestHashRefund({ transactionId, amount: input.amount });
    try {
      return await this.inTransaction((em) => this.refundInTransaction(em, ctx, transactionId, input, requestHash));
    } catch (err) {
      return this.recoverIdempotencyRace(err, ctx.tenantId, input.idempotencyKey, requestHash);
    }
  }

  private async refundInTransaction(
    em: EntityManager,
    ctx: CallerContext,
    transactionId: string,
    input: RefundInput,
    requestHash: Buffer
  ): Promise<TransactionResult> {
    // 1. The redemption. Its card id never changes, so reading it before the lock is safe
    const [original] = await returningRows<{ id: string; gift_card_id: string; type: string; amount: number }>(
      em,
      `SELECT id, gift_card_id, type, amount FROM gift_card_transactions WHERE id = $1 AND tenant_id = $2`,
      [transactionId, ctx.tenantId]
    );
    if (!original) throw new NotFoundError("Transaction not found");

    // 2. Lock the card
    const card = await findCard(em, ctx.tenantId, original.gift_card_id, { forUpdate: true });
    // The ledger row references the card by foreign key
    if (!card) throw new Error("transaction has no gift card");

    // 3. Idempotency, before any mutable rule (a retry after a suspend is still a replay)
    const existing = await this.findByKey(em, ctx.tenantId, input.idempotencyKey);
    if (existing) {
      if (!existing.request_hash || !existing.request_hash.equals(requestHash)) throw idempotencyConflict();
      return this.replayOf(em, ctx.tenantId, existing);
    }

    // 4. Only a redemption can be refunded
    if (original.type !== "redeem") throw new ConflictError("Only a redemption can be refunded");

    // 5. Bounded by the redemption, counting what earlier refunds already returned
    const [bound] = await returningRows<{ ok: boolean }>(
      em,
      `SELECT COALESCE(SUM(amount), 0) + $2::int <= $3::int AS ok
         FROM gift_card_transactions WHERE related_transaction_id = $1 AND type = 'refund'`,
      [original.id, input.amount, original.amount]
    );
    if (!bound.ok) throw new ConflictError("Refund exceeds the refundable amount");

    // 6. Card state
    const decision = decideRefund(snapshot(card), input.amount);
    if (!decision.ok) throw rejectionError(decision.reason);

    // 7. Credit and ledger
    const [updated] = await returningRows<{ balance: number }>(
      em,
      `UPDATE gift_cards SET balance = balance + $3::int, status = 'active', updated_at = now()
        WHERE id = $1 AND tenant_id = $2
    RETURNING balance`,
      [card.id, ctx.tenantId, input.amount]
    );
    if (!updated) throw new Error("refund matched no card row under the row lock");
    const [transaction] = await returningRows<TransactionRow>(
      em,
      `INSERT INTO gift_card_transactions (tenant_id, gift_card_id, currency, type, amount, balance_after,
          related_transaction_id, idempotency_key, request_hash, actor_user_id)
       VALUES ($1, $2, $3, 'refund', $4, $5, $6, $7, $8, $9)
    RETURNING ${TRANSACTION_COLUMNS}`,
      [
        ctx.tenantId,
        card.id,
        card.currency,
        input.amount,
        updated.balance,
        original.id,
        input.idempotencyKey,
        requestHash,
        ctx.userId,
      ]
    );
    return {
      replayed: false,
      transaction: toTransactionResponse(transaction),
      card: await this.loadCard(em, ctx.tenantId, card.id),
    };
  }

  // ---------- shared ----------

  /** One READ COMMITTED transaction whose lock waits are bounded (`55P03` becomes a 503). */
  private inTransaction<T>(run: (em: EntityManager) => Promise<T>): Promise<T> {
    return this.app.db.transaction("READ COMMITTED", async (em) => {
      await em.query(`SET LOCAL lock_timeout = '${this.lockTimeoutMs}ms'`);
      return run(em);
    });
  }

  /**
   * Locks the card by number and checks the PIN under that lock, so attempts are serialized per
   * card. Returns the card when authenticated, null for every failure. A wrong PIN writes the
   * counter (and the lockout, with its audit row) here; the caller commits it.
   */
  private async authenticate(
    em: EntityManager,
    ctx: CallerContext,
    hmac: Buffer,
    pin: string | undefined
  ): Promise<AuthenticatedCardRow | null> {
    const [card] = await returningRows<AuthenticatedCardRow>(
      em,
      `SELECT ${CARD_COLUMNS}, c.pin_enc, c.encryption_key_id, c.failed_pin_attempts
         FROM gift_cards c WHERE c.tenant_id = $1 AND c.card_number_hmac = $2 FOR UPDATE`,
      [ctx.tenantId, hmac]
    );
    if (!card) return null;

    // A locked card is refused without looking at the PIN
    const storedPin =
      card.pin_enc !== null && !card.pin_locked
        ? this.cardCrypto.decrypt(
            "pin",
            { tenantId: ctx.tenantId, cardId: card.id },
            card.encryption_key_id,
            card.pin_enc
          )
        : null;
    const decision = decidePinAttempt({
      hasPin: card.pin_enc !== null,
      providedPin: pin,
      storedPin,
      failedAttempts: card.failed_pin_attempts,
      locked: card.pin_locked,
    });

    switch (decision.outcome) {
      case "locked":
      case "missing_pin":
        return null;
      case "wrong_pin":
        await em.query(
          `UPDATE gift_cards
              SET failed_pin_attempts = $2,
                  pin_locked_until = CASE WHEN $3::boolean THEN now() + make_interval(mins => $4::int) ELSE NULL END,
                  updated_at = now()
            WHERE id = $1`,
          [card.id, decision.failedAttempts, decision.lock, PIN_LOCK_MINUTES]
        );
        if (decision.lock) {
          await writeAudit(em, ctx, { action: "gift_card.pin_locked", details: { giftCardId: card.id } });
        }
        return null;
      case "ok":
        if (decision.resetAttempts) {
          await em.query(`UPDATE gift_cards SET failed_pin_attempts = 0, updated_at = now() WHERE id = $1`, [card.id]);
        }
        return card;
    }
  }

  private async findByKey(em: EntityManager, tenantId: string, idempotencyKey: string) {
    const [row] = await returningRows<KeyedTransactionRow>(
      em,
      `SELECT ${TRANSACTION_COLUMNS}, request_hash FROM gift_card_transactions
        WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey]
    );
    return row;
  }

  private async replayOf(em: EntityManager, tenantId: string, row: KeyedTransactionRow): Promise<TransactionResult> {
    return {
      replayed: true,
      transaction: toTransactionResponse(row),
      card: await this.loadCard(em, tenantId, row.gift_card_id),
    };
  }

  private async loadCard(em: EntityManager, tenantId: string, cardId: string): Promise<GiftCardResponse> {
    const card = await findCard(em, tenantId, cardId);
    // Callers pass an id they just read under the card's foreign key
    if (!card) throw new Error("gift card disappeared");
    return toCardResponse(card);
  }

  /**
   * After rollback, outside any transaction. A concurrent request with this key committed first
   * (the same key used on another card): one fresh read decides replay or conflict. Any other
   * error propagates unchanged.
   */
  private async recoverIdempotencyRace(
    err: unknown,
    tenantId: string,
    idempotencyKey: string,
    requestHash: Buffer
  ): Promise<TransactionResult> {
    if (uniqueViolationConstraint(err) !== IDEMPOTENCY_CONSTRAINT) throw err;
    const existing = await this.findByKey(this.app.db.manager, tenantId, idempotencyKey);
    if (!existing) {
      // The ledger is append-only, so the conflicting row cannot vanish; a bare 23505 would be
      // mapped to 409, so raise a plain error for the 500 path
      throw new Error("idempotency re-read found no row", { cause: err });
    }
    if (!existing.request_hash || !existing.request_hash.equals(requestHash)) throw idempotencyConflict();
    return this.replayOf(this.app.db.manager, tenantId, existing);
  }
}
