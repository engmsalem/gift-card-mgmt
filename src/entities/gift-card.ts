import { Check, Column, CreateDateColumn, Entity, ForeignKey, Index, PrimaryColumn, Unique, UpdateDateColumn } from "typeorm";
import { GiftCardProgram } from "./gift-card-program";
import { Tenant } from "./tenant";
import { User } from "./user";

export type GiftCardStatus = "active" | "suspended" | "depleted" | "voided" | "expired";

// The card number and PIN exist only as AES-GCM ciphertext (card_number_enc, pin_enc); lookup is by
// the keyed HMAC of the number. The secret columns are select: false so a plain find never loads
// them. No relation properties: foreign keys are declared at class level.
@Entity("gift_cards")
@ForeignKey(() => Tenant, ["tenantId"], ["id"], { name: "gift_cards_tenant_id_fkey" })
// Tenant-consistency guarantee: a card's (tenant, currency) equals its program's. ON UPDATE
// NO ACTION also makes the program currency immutable once a card exists.
@ForeignKey(
  () => GiftCardProgram,
  ["programId", "tenantId", "currency"],
  ["id", "tenantId", "currency"],
  { name: "gift_cards_program_fkey" }
)
@ForeignKey(() => User, ["issuedBy"], ["id"], { name: "gift_cards_issued_by_fkey" })
@Unique("gift_cards_tenant_id_reference_number_key", ["tenantId", "referenceNumber"])
// Targets of the composite FKs from gift_card_transactions and gift_card_deliveries
@Unique("gift_cards_id_tenant_id_key", ["id", "tenantId"])
@Unique("gift_cards_id_tenant_id_currency_key", ["id", "tenantId", "currency"])
@Check("gift_cards_status_check", `"status" IN ('active', 'suspended', 'depleted', 'voided', 'expired')`)
@Check("gift_cards_balance_check", `"balance" >= 0 AND "balance" <= "initial_amount"`)
@Check("gift_cards_initial_amount_check", `"initial_amount" > 0`)
@Check(
  "gift_cards_status_balance_check",
  `("status" IN ('active', 'suspended') AND "balance" > 0) OR ("status" IN ('depleted', 'voided') AND "balance" = 0) OR "status" = 'expired'`
)
@Check("gift_cards_hmac_length_check", `octet_length("card_number_hmac") = 32`)
@Check("gift_cards_last4_check", `"card_number_last4" ~ '^[0-9]{4}$'`)
@Check("gift_cards_reference_check", `"reference_number" ~ '^[0-9A-HJKMNP-TV-Z]{12}$'`)
@Check("gift_cards_pin_attempts_check", `"failed_pin_attempts" BETWEEN 0 AND 10`)
@Check(
  "gift_cards_pinless_lockout_check",
  `"pin_enc" IS NOT NULL OR ("failed_pin_attempts" = 0 AND "pin_locked_until" IS NULL)`
)
export class GiftCard {
  @PrimaryColumn({ type: "uuid", default: () => "uuidv7()" })
  id: string;

  @Column({ name: "tenant_id", type: "uuid" })
  tenantId: string;

  @Index("gift_cards_program_id_idx")
  @Column({ name: "program_id", type: "uuid" })
  programId: string;

  @Column({ type: "char", length: 3 })
  currency: string;

  @Column({ name: "reference_number", type: "char", length: 12 })
  referenceNumber: string;

  @Column({ name: "card_number_enc", type: "bytea", select: false })
  cardNumberEnc: Buffer;

  @Column({ name: "card_number_hmac", type: "bytea", unique: true, select: false })
  cardNumberHmac: Buffer;

  @Column({ name: "card_number_last4", type: "char", length: 4 })
  cardNumberLast4: string;

  @Column({ name: "pin_enc", type: "bytea", nullable: true, select: false })
  pinEnc: Buffer | null;

  @Column({ name: "encryption_key_id", type: "smallint" })
  encryptionKeyId: number;

  @Column({ name: "lookup_key_id", type: "smallint" })
  lookupKeyId: number;

  @Column({ name: "initial_amount", type: "integer" })
  initialAmount: number;

  @Column({ type: "integer" })
  balance: number;

  @Column({ type: "varchar", length: 16 })
  status: GiftCardStatus;

  @Column({ name: "expires_at", type: "timestamptz", nullable: true })
  expiresAt: Date | null;

  @Column({ name: "failed_pin_attempts", type: "smallint", default: 0 })
  failedPinAttempts: number;

  @Column({ name: "pin_locked_until", type: "timestamptz", nullable: true })
  pinLockedUntil: Date | null;

  @Column({ name: "issued_by", type: "uuid" })
  issuedBy: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
