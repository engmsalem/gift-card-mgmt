import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { DataSource, EntityManager } from "typeorm";
import {
  DELIVERY_TOKEN_EXPIRES_AT_SQL,
  buildDeliveryLink,
  generateDeliveryToken,
  hashDeliveryToken,
} from "../gift-cards/delivery-token";
import { currencyExponent } from "../gift-cards/money";
import { returningRows } from "./sql";

export interface GiftCardDeliveryMessage {
  deliveryId: string;
  tenantId: string;
  to: { name: string; email: string };
  senderName: string;
  message: string | null;
  merchantName: string;
  programName: string;
  amount: number;
  currency: string;
  currencyExponent: number;
  /** Contains the raw token; never logged. */
  link: string;
}

/** The outbound email port, declared by its consumer (the dispatcher). Throws on failure. */
export interface GiftCardDeliverySender {
  send(message: GiftCardDeliveryMessage, signal: AbortSignal): Promise<void>;
}

export interface DispatcherLog {
  info(o: object, m: string): void;
  warn(o: object, m: string): void;
}

export interface DeliveryDispatcherOptions {
  db: DataSource;
  sender: GiftCardDeliverySender;
  linkBaseUrl: string;
  log: DispatcherLog;
  randomBytes?: (n: number) => Buffer;
  /** Hard bound on one send. Default 10 s, at most 60 s. */
  sendTimeoutMs?: number;
}

export interface DispatchInput {
  deliveryId?: string;
  limit?: number;
  /**
   * Rethrow a database failure instead of logging it. For the dispatch script only: a cron job must
   * exit non-zero. Never set for the in-request call, which must not fail the HTTP request.
   */
  throwOnError?: boolean;
}

const DEFAULT_SEND_TIMEOUT_MS = 10_000;
const MAX_SEND_TIMEOUT_MS = 60_000;
const DEFAULT_LIMIT = 50;
// A `sending` row older than this lease is reclaimed. It must exceed MAX_SEND_TIMEOUT_MS plus a margin.
const LEASE_MINUTES = 10;
const MAX_ATTEMPTS = 5;

/** The send did not settle within the timeout (the sender may have ignored the abort signal). */
class SendTimeout extends Error {
  constructor() {
    super("send timed out");
    this.name = "SendTimeout";
  }
}

/**
 * Settles with the send, or rejects when the signal aborts, whichever comes first. A sender that
 * ignores the signal and never settles is abandoned: its late result or failure is swallowed here.
 */
function raceTimeout(work: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new SendTimeout());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

interface ClaimRow {
  id: string;
  card_status: string;
  card_expired: boolean;
}

interface ClaimedDelivery {
  deliveryId: string;
  tenantId: string;
  attempt: number;
  tokenHash: Buffer;
  message: GiftCardDeliveryMessage;
}

/**
 * Claims due deliveries one at a time, mints each one's token at claim, sends under a hard timeout
 * and records the outcome (design 6.3). It never decrypts a card and never locks one: delivery
 * UPDATEs leave `(gift_card_id, tenant_id)` alone, so no FK check takes a lock on the card.
 * Delivery is at-least-once: a crash after the claim is reclaimed once the lease passes.
 */
export class DeliveryDispatcher {
  private readonly db: DataSource;
  private readonly sender: GiftCardDeliverySender;
  private readonly linkBaseUrl: string;
  private readonly log: DispatcherLog;
  private readonly randomBytes: (n: number) => Buffer;
  private readonly sendTimeoutMs: number;

  constructor(opts: DeliveryDispatcherOptions) {
    const sendTimeoutMs = opts.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    if (!Number.isInteger(sendTimeoutMs) || sendTimeoutMs < 1 || sendTimeoutMs > MAX_SEND_TIMEOUT_MS) {
      throw new RangeError(`sendTimeoutMs must be an integer from 1 to ${MAX_SEND_TIMEOUT_MS}`);
    }
    this.db = opts.db;
    this.sender = opts.sender;
    this.linkBaseUrl = opts.linkBaseUrl;
    this.log = opts.log;
    this.randomBytes = opts.randomBytes ?? cryptoRandomBytes;
    this.sendTimeoutMs = sendTimeoutMs;
  }

  /**
   * Processes up to `limit` due deliveries (only `deliveryId` when given) and resolves with how many
   * it claimed. Bounded (each send is under the timeout) and, by default, never throws: a failure of
   * the database itself is logged and ends the pass, so a caller that already committed its change
   * (issue, resend) is not failed by it. The delivery then stays due and is picked up by the next
   * pass. With `throwOnError` that failure is rethrown instead. A failed send is not a database
   * failure: it is recorded for retry and never throws.
   */
  async dispatch(input: DispatchInput = {}): Promise<number> {
    const limit = input.limit ?? DEFAULT_LIMIT;
    let claimed = 0;
    while (claimed < limit) {
      try {
        const next = await this.claim(input.deliveryId ?? null);
        if (next === "none") break;
        claimed++;
        if (next !== "cancelled") await this.sendAndRecord(next);
      } catch (err) {
        if (input.throwOnError) throw err;
        this.log.warn({ deliveryId: input.deliveryId, errName: errorName(err) }, "gift card dispatch pass failed");
        break;
      }
    }
    return claimed;
  }

  /** One claim transaction. `cancelled` means the card was voided or expired and nothing was sent. */
  private claim(deliveryId: string | null): Promise<ClaimedDelivery | "cancelled" | "none"> {
    return this.db.transaction("READ COMMITTED", async (em) => {
      const [row] = await returningRows<ClaimRow>(
        em,
        `SELECT d.id, c.status AS card_status,
                (c.expires_at IS NOT NULL AND c.expires_at <= now()) AS card_expired
           FROM gift_card_deliveries d
           JOIN gift_cards c ON c.id = d.gift_card_id AND c.tenant_id = d.tenant_id
          WHERE ($1::uuid IS NULL OR d.id = $1::uuid)
            AND ((d.status = 'scheduled' AND d.next_attempt_at <= now())
              OR (d.status = 'sending'   AND d.claimed_at < now() - make_interval(mins => $2::int)))
          ORDER BY d.next_attempt_at, d.id
          LIMIT 1
            FOR UPDATE OF d SKIP LOCKED`,
        [deliveryId, LEASE_MINUTES]
      );
      if (!row) return "none";

      if (row.card_status === "voided" || row.card_expired) {
        await em.query(
          `UPDATE gift_card_deliveries SET status = 'cancelled', claimed_at = NULL, token_hash = NULL,
              token_expires_at = NULL, updated_at = now()
            WHERE id = $1`,
          [row.id]
        );
        return "cancelled";
      }

      const token = generateDeliveryToken(this.randomBytes);
      const tokenHash = hashDeliveryToken(token);
      return this.markSending(em, row.id, token, tokenHash);
    });
  }

  private async markSending(em: EntityManager, id: string, token: string, tokenHash: Buffer): Promise<ClaimedDelivery> {
    const [d] = await returningRows<{
      tenant_id: string;
      gift_card_id: string;
      recipient_name: string;
      recipient_email: string;
      sender_name: string;
      message: string | null;
      attempts: number;
    }>(
      em,
      `UPDATE gift_card_deliveries
          SET status = 'sending', claimed_at = now(), attempts = attempts + 1, token_hash = $2,
              token_expires_at = ${DELIVERY_TOKEN_EXPIRES_AT_SQL}, updated_at = now()
        WHERE id = $1
    RETURNING tenant_id, gift_card_id, recipient_name, recipient_email, sender_name, message, attempts`,
      [id, tokenHash]
    );
    const [info] = await returningRows<{
      currency: string;
      initial_amount: number;
      program_name: string;
      merchant_name: string;
    }>(
      em,
      `SELECT c.currency, c.initial_amount, p.name AS program_name, t.name AS merchant_name
         FROM gift_cards c
         JOIN gift_card_programs p ON p.id = c.program_id AND p.tenant_id = c.tenant_id
         JOIN tenants t ON t.id = c.tenant_id
        WHERE c.id = $1 AND c.tenant_id = $2`,
      [d.gift_card_id, d.tenant_id]
    );
    const exponent = currencyExponent(info.currency);
    // Unreachable: programs only accept supported currencies
    if (exponent === null) throw new Error("card has an unsupported currency");
    return {
      deliveryId: id,
      tenantId: d.tenant_id,
      attempt: d.attempts,
      tokenHash,
      message: {
        deliveryId: id,
        tenantId: d.tenant_id,
        to: { name: d.recipient_name, email: d.recipient_email },
        senderName: d.sender_name,
        message: d.message,
        merchantName: info.merchant_name,
        programName: info.program_name,
        amount: info.initial_amount,
        currency: info.currency,
        currencyExponent: exponent,
        link: buildDeliveryLink(this.linkBaseUrl, token),
      },
    };
  }

  private async sendAndRecord(claimed: ClaimedDelivery): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.sendTimeoutMs);
    let failure: string | null = null;
    try {
      // The promise constructor also turns a synchronous throw into a rejection
      const sent = new Promise<void>((resolve) => resolve(this.sender.send(claimed.message, controller.signal)));
      await raceTimeout(sent, controller.signal);
    } catch (err) {
      // Deliberately keeps only the error's name: its message could carry the link or the address
      failure = errorName(err);
    } finally {
      clearTimeout(timer);
    }

    const { deliveryId, tenantId, attempt, tokenHash } = claimed;
    // Guarded by the token: a void, a resend or a reclaim in the meantime makes this a no-op
    const rows =
      failure === null
        ? await returningRows<{ id: string }>(
            this.db.manager,
            `UPDATE gift_card_deliveries SET status = 'sent', sent_at = now(), claimed_at = NULL, updated_at = now()
              WHERE id = $1 AND status = 'sending' AND token_hash = $2
          RETURNING id`,
            [deliveryId, tokenHash]
          )
        : await returningRows<{ id: string }>(
            this.db.manager,
            `UPDATE gift_card_deliveries
                SET status = CASE WHEN attempts >= $4::int THEN 'failed' ELSE 'scheduled' END,
                    next_attempt_at = now() + make_interval(mins => power(2, attempts)::int),
                    last_error = left($3, 64), claimed_at = NULL,
                    token_hash = CASE WHEN attempts >= $4::int THEN NULL ELSE token_hash END,
                    token_expires_at = CASE WHEN attempts >= $4::int THEN NULL ELSE token_expires_at END,
                    updated_at = now()
              WHERE id = $1 AND status = 'sending' AND token_hash = $2
          RETURNING id`,
            [deliveryId, tokenHash, failure, MAX_ATTEMPTS]
          );

    if (rows.length === 0) {
      this.log.info({ deliveryId, tenantId, attempt }, "gift card delivery outcome not recorded: the delivery changed during the send");
    } else if (failure === null) {
      this.log.info({ deliveryId, tenantId, attempt }, "gift card delivery sent");
    } else {
      this.log.warn({ deliveryId, tenantId, attempt, errName: failure }, "gift card delivery attempt failed");
    }
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "Error";
}
