import { Check, Column, CreateDateColumn, Entity, ForeignKey, PrimaryColumn, Unique, UpdateDateColumn } from "typeorm";
import { Tenant } from "./tenant";

export type GiftCardProgramType = "paid" | "promotional";
export type GiftCardProgramStatus = "active" | "retired";

// Persistence model for src/migrations/1760000300000-AddGiftCards. No relation properties: the
// foreign keys are declared at class level and enforced by the database.
@Entity("gift_card_programs")
@ForeignKey(() => Tenant, ["tenantId"], ["id"], { name: "gift_card_programs_tenant_id_fkey" })
@Unique("gift_card_programs_tenant_id_name_key", ["tenantId", "name"])
// Target of the composite FK that ties a card to its program's tenant and currency
@Unique("gift_card_programs_id_tenant_id_currency_key", ["id", "tenantId", "currency"])
@Check("gift_card_programs_card_type_check", `"card_type" IN ('paid', 'promotional')`)
@Check("gift_card_programs_status_check", `"status" IN ('active', 'retired')`)
@Check("gift_card_programs_currency_check", `"currency" ~ '^[A-Z]{3}$'`)
@Check("gift_card_programs_country_check", `"country" ~ '^[A-Z]{2}$'`)
@Check(
  "gift_card_programs_region_check",
  `"region" IS NULL OR ("region" ~ '^[A-Z]{2}-[A-Z0-9]{1,3}$' AND left("region", 2) = "country")`
)
@Check("gift_card_programs_prefix_check", `"card_number_prefix" ~ '^[7-9][0-9]{3,5}$'`)
@Check("gift_card_programs_length_check", `"card_number_length" BETWEEN 16 AND 19`)
@Check("gift_card_programs_pinless_length_check", `"pin_required" OR "card_number_length" = 19`)
@Check("gift_card_programs_max_value_check", `"max_value" > 0`)
@Check(
  "gift_card_programs_expiry_check",
  `"expiry_months" IS NULL OR ("card_type" = 'promotional' AND "expiry_months" BETWEEN 1 AND 120)`
)
@Check(
  "gift_card_programs_staff_limit_check",
  `"staff_daily_issue_limit" IS NULL OR ("card_type" = 'paid' AND "staff_daily_issue_limit" > 0)`
)
export class GiftCardProgram {
  @PrimaryColumn({ type: "uuid", default: () => "uuidv7()" })
  id: string;

  @Column({ name: "tenant_id", type: "uuid" })
  tenantId: string;

  @Column({ type: "varchar", length: 100 })
  name: string;

  @Column({ name: "card_type", type: "varchar", length: 16 })
  cardType: GiftCardProgramType;

  @Column({ type: "char", length: 3 })
  currency: string;

  @Column({ type: "char", length: 2 })
  country: string;

  @Column({ type: "varchar", length: 6, nullable: true })
  region: string | null;

  @Column({ name: "card_number_prefix", type: "varchar", length: 6 })
  cardNumberPrefix: string;

  @Column({ name: "card_number_length", type: "smallint" })
  cardNumberLength: number;

  @Column({ name: "pin_required", type: "boolean" })
  pinRequired: boolean;

  @Column({ name: "max_value", type: "integer" })
  maxValue: number;

  @Column({ name: "expiry_months", type: "smallint", nullable: true })
  expiryMonths: number | null;

  @Column({ name: "staff_daily_issue_limit", type: "integer", nullable: true })
  staffDailyIssueLimit: number | null;

  @Column({ type: "varchar", length: 16, default: "active" })
  status: GiftCardProgramStatus;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
