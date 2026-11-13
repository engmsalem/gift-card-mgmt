import { FastifyInstance } from "fastify";
import { assertValidEmail, normalizeEmail } from "../credentials";
import type { GiftCardStatus } from "../entities/gift-card";
import { Role } from "../enums/roles";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors";
import type { CardCrypto } from "../gift-cards/card-crypto";
import {
  CARD_EXPIRED_MESSAGE,
  CARD_VOIDED_MESSAGE,
  effectiveStatus,
} from "../gift-cards/card-state";
import { hashDeliveryToken } from "../gift-cards/delivery-token";
import { maskEmail } from "../gift-cards/mask";
import { currencyExponent } from "../gift-cards/money";
import { writeAudit } from "./audit";
import type { DeliveryDispatcher } from "./deliveryDispatcher";
import type { CallerContext } from "./giftCardProgramService";
import { CARD_NOT_FOUND_MESSAGE, GiftCardDeliveryResponse, loadDelivery } from "./giftCardService";
import { returningRows } from "./sql";

export interface ResendContext extends CallerContext {
  role: Role;
}

export interface ResendInput {
  recipient?: { name?: string; email?: string };
}

export interface RevealResponse {
  cardNumber: string;
  /** Null when the program has no PIN. */
  pin: string | null;
  balance: number;
  currency: string;
  currencyExponent: number;
  status: GiftCardStatus;
  expiresAt: Date | null;
  programName: string;
  merchantName: string;
  recipientName: string;
  senderName: string;
  message: string | null;
}

const LINK_NOT_VALID = "Link is invalid or has expired";

interface RevealRow {
  id: string;
  recipient_name: string;
  sender_name: string;
  message: string | null;
  card_id: string;
  tenant_id: string;
  card_number_enc: Buffer;
  pin_enc: Buffer | null;
  encryption_key_id: number;
  balance: number;
  currency: string;
  status: GiftCardStatus;
  expires_at: Date | null;
  is_expired: boolean;
  program_name: string;
  merchant_name: string;
}

export class DeliveryService {
  constructor(
    private app: FastifyInstance,
    private cardCrypto: CardCrypto,
    private dispatcher: DeliveryDispatcher
  ) {}

  // ---------- resend (design 7.7) ----------

  /**
   * Replaces the delivery's token and sends again. Lock order is card, then delivery (the same as
   * void). Staff resend to the recipient on file; only an admin can change it.
   */
  async resend(ctx: ResendContext, cardId: string, input: ResendInput): Promise<GiftCardDeliveryResponse> {
    const newEmail = input.recipient?.email === undefined ? undefined : normalizeEmail(input.recipient.email);
    if (newEmail !== undefined) assertValidEmail(newEmail);

    const deliveryId = await this.app.db.transaction("READ COMMITTED", async (em) => {
      const [card] = await returningRows<{ status: GiftCardStatus; is_expired: boolean }>(
        em,
        `SELECT status, (expires_at IS NOT NULL AND expires_at <= now()) AS is_expired
           FROM gift_cards WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [cardId, ctx.tenantId]
      );
      if (!card) throw new NotFoundError(CARD_NOT_FOUND_MESSAGE);
      const status = effectiveStatus({ status: card.status, isExpired: card.is_expired });
      if (status === "voided") throw new ConflictError(CARD_VOIDED_MESSAGE);
      if (status === "expired") throw new ConflictError(CARD_EXPIRED_MESSAGE);

      const [delivery] = await returningRows<{ id: string; recipient_name: string; recipient_email: string }>(
        em,
        `SELECT id, recipient_name, recipient_email FROM gift_card_deliveries
          WHERE gift_card_id = $1 AND tenant_id = $2 FOR UPDATE`,
        [cardId, ctx.tenantId]
      );
      // Issue creates the delivery with the card, so this is an invariant
      if (!delivery) throw new Error("gift card has no delivery");

      const name = input.recipient?.name ?? delivery.recipient_name;
      const email = newEmail ?? delivery.recipient_email;
      const recipientChanged = name !== delivery.recipient_name || email !== delivery.recipient_email;
      if (recipientChanged && ctx.role !== Role.ADMIN) {
        throw new ForbiddenError("Only an admin can change the recipient");
      }

      // A delivery still scheduled for the future keeps its send date: GREATEST leaves the claim
      // below (next_attempt_at <= now()) with nothing to take, so the response reports `scheduled`
      await em.query(
        `UPDATE gift_card_deliveries
            SET recipient_name = $3, recipient_email = $4, status = 'scheduled',
                next_attempt_at = GREATEST(send_at, now()), attempts = 0, claimed_at = NULL, last_error = NULL, token_hash = NULL,
                token_expires_at = NULL, updated_at = now()
          WHERE id = $1 AND tenant_id = $2`,
        [delivery.id, ctx.tenantId, name, email]
      );
      await writeAudit(em, ctx, {
        action: "gift_card_delivery.resent",
        details: {
          giftCardId: cardId,
          deliveryId: delivery.id,
          recipientChanged,
          ...(recipientChanged
            ? { previousRecipient: maskEmail(delivery.recipient_email), newRecipient: maskEmail(email) }
            : {}),
        },
      });
      return delivery.id;
    });

    await this.dispatcher.dispatch({ deliveryId });
    // Dispatch may have sent it, failed, or left it for the next pass: report the real status
    return loadDelivery(this.app.db.manager, ctx.tenantId, cardId);
  }

  // ---------- reveal (design 6.4) ----------

  /**
   * Exchanges a delivery token for the card number, PIN and balance. The only path that decrypts a
   * card for a recipient. The tenant comes from the delivery row, not from the caller.
   */
  async reveal(token: string): Promise<RevealResponse> {
    const tokenHash = hashDeliveryToken(token);
    const em = this.app.db.manager;
    const [row] = await returningRows<RevealRow>(
      em,
      `SELECT d.id, d.recipient_name, d.sender_name, d.message, c.id AS card_id, c.tenant_id,
              c.card_number_enc, c.pin_enc, c.encryption_key_id, c.balance, c.currency, c.status,
              c.expires_at, (c.expires_at IS NOT NULL AND c.expires_at <= now()) AS is_expired,
              p.name AS program_name, t.name AS merchant_name
         FROM gift_card_deliveries d
         JOIN gift_cards c         ON c.id = d.gift_card_id AND c.tenant_id = d.tenant_id
         JOIN gift_card_programs p ON p.id = c.program_id AND p.tenant_id = c.tenant_id
         JOIN tenants t            ON t.id = c.tenant_id
        WHERE d.token_hash = $1 AND d.token_expires_at > now() AND c.status <> 'voided'`,
      [tokenHash]
    );
    if (!row) throw new NotFoundError(LINK_NOT_VALID);

    // Guarded by the token, so a void or resend that landed since the read wins
    const counted = await returningRows<{ id: string }>(
      em,
      `UPDATE gift_card_deliveries
          SET opened_at = COALESCE(opened_at, now()), reveal_count = reveal_count + 1,
              last_revealed_at = now(), updated_at = now()
        WHERE id = $1 AND token_hash = $2 AND token_expires_at > now()
    RETURNING id`,
      [row.id, tokenHash]
    );
    if (counted.length === 0) throw new NotFoundError(LINK_NOT_VALID);

    const exponent = currencyExponent(row.currency);
    // Unreachable: programs only accept supported currencies
    if (exponent === null) throw new Error("card has an unsupported currency");
    const ids = { tenantId: row.tenant_id, cardId: row.card_id };
    return {
      cardNumber: this.cardCrypto.decrypt("number", ids, row.encryption_key_id, row.card_number_enc),
      pin: row.pin_enc === null ? null : this.cardCrypto.decrypt("pin", ids, row.encryption_key_id, row.pin_enc),
      balance: row.balance,
      currency: row.currency,
      currencyExponent: exponent,
      status: effectiveStatus({ status: row.status, isExpired: row.is_expired }),
      expiresAt: row.expires_at,
      programName: row.program_name,
      merchantName: row.merchant_name,
      recipientName: row.recipient_name,
      senderName: row.sender_name,
      message: row.message,
    };
  }
}
