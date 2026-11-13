import { Check, Column, CreateDateColumn, Entity, ForeignKey, Index, PrimaryColumn, Unique } from "typeorm";
import { GiftCard } from "./gift-card";
import { User } from "./user";

export type GiftCardTransactionType = "issue" | "redeem" | "refund" | "void";

// The append-only balance ledger: a trigger rejects every UPDATE and DELETE (see
// 1760000300000-AddGiftCards), so there is no updated_at. No relation properties.
@Entity("gift_card_transactions")
@ForeignKey(
  () => GiftCard,
  ["giftCardId", "tenantId", "currency"],
  ["id", "tenantId", "currency"],
  { name: "gift_card_transactions_card_fkey" }
)
@ForeignKey(() => User, ["actorUserId"], ["id"], { name: "gift_card_transactions_actor_fkey" })
// A refund points at a transaction of the same card
@ForeignKey(
  () => GiftCardTransaction,
  ["relatedTransactionId", "giftCardId"],
  ["id", "giftCardId"],
  { name: "gift_card_transactions_related_fkey" }
)
@Unique("gift_card_transactions_tenant_id_idempotency_key_key", ["tenantId", "idempotencyKey"])
@Unique("gift_card_transactions_id_gift_card_id_key", ["id", "giftCardId"])
@Index("gift_card_transactions_gift_card_id_created_at_idx", ["giftCardId", "createdAt"])
@Index("gift_card_transactions_actor_user_id_created_at_idx", ["actorUserId", "createdAt"])
@Check("gift_card_transactions_type_check", `"type" IN ('issue', 'redeem', 'refund', 'void')`)
@Check("gift_card_transactions_amount_check", `"amount" > 0`)
@Check("gift_card_transactions_balance_after_check", `"balance_after" >= 0`)
@Check("gift_card_transactions_related_check", `("type" = 'refund') = ("related_transaction_id" IS NOT NULL)`)
@Check(
  "gift_card_transactions_idempotency_check",
  `("idempotency_key" IS NULL) = ("request_hash" IS NULL) AND (("type" = 'void') = ("idempotency_key" IS NULL))`
)
export class GiftCardTransaction {
  @PrimaryColumn({ type: "uuid", default: () => "uuidv7()" })
  id: string;

  @Column({ name: "tenant_id", type: "uuid" })
  tenantId: string;

  @Column({ name: "gift_card_id", type: "uuid" })
  giftCardId: string;

  @Column({ type: "char", length: 3 })
  currency: string;

  @Column({ type: "varchar", length: 16 })
  type: GiftCardTransactionType;

  @Column({ type: "integer" })
  amount: number;

  @Column({ name: "balance_after", type: "integer" })
  balanceAfter: number;

  @Index("gift_card_transactions_related_transaction_id_idx")
  @Column({ name: "related_transaction_id", type: "uuid", nullable: true })
  relatedTransactionId: string | null;

  @Column({ name: "idempotency_key", type: "varchar", length: 64, nullable: true })
  idempotencyKey: string | null;

  @Column({ name: "request_hash", type: "bytea", nullable: true, select: false })
  requestHash: Buffer | null;

  @Column({ name: "external_reference", type: "varchar", length: 64, nullable: true })
  externalReference: string | null;

  @Column({ name: "actor_user_id", type: "uuid" })
  actorUserId: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
