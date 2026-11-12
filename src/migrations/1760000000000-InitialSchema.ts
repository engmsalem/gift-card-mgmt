import { MigrationInterface, QueryRunner } from "typeorm";

// Source of truth for the initial schema (PostgreSQL). Replaces the old db/schema.sql.
export class InitialSchema1760000000000 implements MigrationInterface {
  name = "InitialSchema1760000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "user_role" AS ENUM ('admin', 'staff')`);
    await queryRunner.query(
      `CREATE TYPE "gift_card_status" AS ENUM ('active', 'inactive', 'expired')`
    );
    await queryRunner.query(
      `CREATE TYPE "transaction_type" AS ENUM ('redemption', 'refund')`
    );

    await queryRunner.query(`
      CREATE TABLE "tenants" (
        "id"          uuid PRIMARY KEY DEFAULT uuidv7(),
        "name"        varchar(100) NOT NULL,
        "subdomain"   varchar(50)  NOT NULL UNIQUE,
        "created_at"  timestamptz  NOT NULL DEFAULT now(),
        "updated_at"  timestamptz  NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "users" (
        "id"             uuid PRIMARY KEY DEFAULT uuidv7(),
        "tenant_id"      uuid         NOT NULL REFERENCES "tenants" ("id"),
        "name"           varchar(100) NOT NULL,
        "email"          varchar(254) NOT NULL UNIQUE,
        "password_hash"  varchar(255) NOT NULL,
        "role"           "user_role"  NOT NULL DEFAULT 'staff',
        "created_at"     timestamptz  NOT NULL DEFAULT now(),
        "updated_at"     timestamptz  NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "users_tenant_id_idx" ON "users" ("tenant_id")`);

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

    await queryRunner.query(`
      CREATE TABLE "audit_logs" (
        "id"          uuid PRIMARY KEY DEFAULT uuidv7(),
        "tenant_id"   uuid   REFERENCES "tenants" ("id"),
        "action"      varchar(100) NOT NULL,
        "user_id"     uuid   REFERENCES "users" ("id"),
        "details"     jsonb,
        "created_at"  timestamptz  NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "audit_logs_tenant_id_idx" ON "audit_logs" ("tenant_id")`
    );
    await queryRunner.query(
      `CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs" ("user_id")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "audit_logs"`);
    await queryRunner.query(`DROP TABLE "transactions"`);
    await queryRunner.query(`DROP TABLE "gift_cards"`);
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TABLE "tenants"`);
    await queryRunner.query(`DROP TYPE "transaction_type"`);
    await queryRunner.query(`DROP TYPE "gift_card_status"`);
    await queryRunner.query(`DROP TYPE "user_role"`);
  }
}
