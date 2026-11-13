import { Check, Column, CreateDateColumn, Entity, PrimaryColumn } from "typeorm";

export type GiftCardKeyPurpose = "encryption" | "lookup";

// Non-secret key check values (never the keys), compared at startup by verifyCardKeys.
@Entity("gift_card_key_checks")
@Check("gift_card_key_checks_purpose_check", `"purpose" IN ('encryption', 'lookup')`)
@Check("gift_card_key_checks_length_check", `octet_length("check_value") = 16`)
export class GiftCardKeyCheck {
  @PrimaryColumn({ type: "varchar", length: 16 })
  purpose: GiftCardKeyPurpose;

  @PrimaryColumn({ name: "key_id", type: "smallint" })
  keyId: number;

  @Column({ name: "check_value", type: "bytea" })
  checkValue: Buffer;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
