import { MigrationInterface, QueryRunner } from "typeorm";

// Drops the unused legacy gift_cards (plaintext pin) and transactions tables and their enums.
// The new gift-card schema (1760000300000-AddGiftCards) reuses the table name gift_cards.
//
// PRE-CHECK: up() itself refuses (RAISE EXCEPTION, whole migration rolls back) if either legacy
//   table has a row. Expected: both empty.
//     SELECT (SELECT count(*) FROM "gift_cards") AS cards, (SELECT count(*) FROM "transactions") AS txns;
// VERIFY:
//     SELECT to_regclass('public.transactions'), to_regclass('public.gift_cards');   -- both NULL
//     SELECT typname FROM pg_type WHERE typname IN ('transaction_type', 'gift_card_status');   -- no rows
// ROLLBACK: down() recreates the empty legacy tables exactly as InitialSchema did. Data dropped
//   by up() cannot be restored, which is why up() refuses when there is any.
export class DropLegacyGiftCardTables1760000200000 implements MigrationInterface {
  name = "DropLegacyGiftCardTables1760000200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM "gift_cards") OR EXISTS (SELECT 1 FROM "transactions") THEN
          RAISE EXCEPTION 'legacy gift_cards/transactions contain rows; export or delete them first';
        END IF;
      END
      $$
    `);
    await queryRunner.query(`DROP TABLE "transactions"`);
    await queryRunner.query(`DROP TABLE "gift_cards"`);
    await queryRunner.query(`DROP TYPE "transaction_type"`);
    await queryRunner.query(`DROP TYPE "gift_card_status"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Same definitions as InitialSchema1760000000000
    await queryRunner.query(
      `CREATE TYPE "gift_card_status" AS ENUM ('active', 'inactive', 'expired')`
    );
    await queryRunner.query(
      `CREATE TYPE "transaction_type" AS ENUM ('redemption', 'refund')`
    );
    await queryRunner.query(`
      CREATE TABLE "gift_cards" (
        "id"           uuid PRIMARY KEY DEFAULT uuidv7(),
        "tenant_id"    uuid          NOT NULL REFERENCES "tenants" ("id"),
        "card_number"  varchar(16)   NOT NULL UNIQUE,
        "pin"          varchar(6)    NOT NULL,
        "balance"      numeric(10,2) NOT NULL DEFAULT 0.00,
        "expiry_date"  date          NOT NULL,
        "status"       "gift_card_status" NOT NULL DEFAULT 'active',
        "created_at"   timestamptz   NOT NULL DEFAULT now(),
        "updated_at"   timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT "gift_cards_balance_nonnegative" CHECK ("balance" >= 0)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "gift_cards_tenant_id_idx" ON "gift_cards" ("tenant_id")`
    );
    await queryRunner.query(`
      CREATE TABLE "transactions" (
        "id"            uuid PRIMARY KEY DEFAULT uuidv7(),
        "tenant_id"     uuid               NOT NULL REFERENCES "tenants" ("id"),
        "gift_card_id"  uuid               NOT NULL REFERENCES "gift_cards" ("id"),
        "type"          "transaction_type" NOT NULL,
        "amount"        numeric(10,2)      NOT NULL,
        "created_at"    timestamptz        NOT NULL DEFAULT now(),
        CONSTRAINT "transactions_amount_positive" CHECK ("amount" > 0)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "transactions_tenant_id_idx" ON "transactions" ("tenant_id")`
    );
    await queryRunner.query(
      `CREATE INDEX "transactions_gift_card_id_idx" ON "transactions" ("gift_card_id")`
    );
  }
}
