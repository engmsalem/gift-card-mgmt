import { Check, Column, CreateDateColumn, Entity, ForeignKey, Index, PrimaryColumn, UpdateDateColumn } from "typeorm";
import { GiftCard } from "./gift-card";
import { User } from "./user";

export type GiftCardDeliveryStatus = "scheduled" | "sending" | "sent" | "failed" | "cancelled";

// One delivery (the recipient email and its token state) per card. Only the SHA-256 hash of the
// reveal token is stored. No relation properties.
@Entity("gift_card_deliveries")
@ForeignKey(() => GiftCard, ["giftCardId", "tenantId"], ["id", "tenantId"], { name: "gift_card_deliveries_card_fkey" })
@ForeignKey(() => User, ["createdBy"], ["id"], { name: "gift_card_deliveries_created_by_fkey" })
@Index("gift_card_deliveries_due_idx", ["status", "nextAttemptAt"])
@Check(
  "gift_card_deliveries_status_check",
  `"status" IN ('scheduled', 'sending', 'sent', 'failed', 'cancelled')`
)
@Check("gift_card_deliveries_attempts_check", `"attempts" BETWEEN 0 AND 100`)
@Check("gift_card_deliveries_reveal_count_check", `"reveal_count" >= 0`)
@Check("gift_card_deliveries_token_pair_check", `("token_hash" IS NULL) = ("token_expires_at" IS NULL)`)
@Check("gift_card_deliveries_token_hash_length_check", `"token_hash" IS NULL OR octet_length("token_hash") = 32`)
@Check("gift_card_deliveries_claimed_check", `("status" = 'sending') = ("claimed_at" IS NOT NULL)`)
@Check("gift_card_deliveries_cancelled_token_check", `"status" NOT IN ('cancelled', 'failed') OR "token_hash" IS NULL`)
export class GiftCardDelivery {
  @PrimaryColumn({ type: "uuid", default: () => "uuidv7()" })
  id: string;

  @Column({ name: "tenant_id", type: "uuid" })
  tenantId: string;

  @Column({ name: "gift_card_id", type: "uuid", unique: true })
  giftCardId: string;

  @Column({ name: "recipient_name", type: "varchar", length: 100 })
  recipientName: string;

  @Column({ name: "recipient_email", type: "varchar", length: 254 })
  recipientEmail: string;

  @Column({ name: "sender_name", type: "varchar", length: 100 })
  senderName: string;

  @Column({ type: "varchar", length: 500, nullable: true })
  message: string | null;

  @Column({ name: "send_at", type: "timestamptz" })
  sendAt: Date;

  @Column({ type: "varchar", length: 16, default: "scheduled" })
  status: GiftCardDeliveryStatus;

  @Column({ type: "smallint", default: 0 })
  attempts: number;

  @Column({ name: "next_attempt_at", type: "timestamptz" })
  nextAttemptAt: Date;

  @Column({ name: "claimed_at", type: "timestamptz", nullable: true })
  claimedAt: Date | null;

  @Column({ name: "last_error", type: "varchar", length: 64, nullable: true })
  lastError: string | null;

  @Column({ name: "sent_at", type: "timestamptz", nullable: true })
  sentAt: Date | null;

  @Column({ name: "opened_at", type: "timestamptz", nullable: true })
  openedAt: Date | null;

  @Column({ name: "reveal_count", type: "integer", default: 0 })
  revealCount: number;

  @Column({ name: "last_revealed_at", type: "timestamptz", nullable: true })
  lastRevealedAt: Date | null;

  @Column({ name: "token_hash", type: "bytea", unique: true, nullable: true, select: false })
  tokenHash: Buffer | null;

  @Column({ name: "token_expires_at", type: "timestamptz", nullable: true })
  tokenExpiresAt: Date | null;

  @Column({ name: "created_by", type: "uuid" })
  createdBy: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
