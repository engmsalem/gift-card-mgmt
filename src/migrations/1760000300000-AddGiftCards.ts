import { MigrationInterface, QueryRunner } from "typeorm";

// Digital gift cards: programs, cards (secrets encrypted, lookup by keyed HMAC), the append-only
// ledger, deliveries and the key-check table. Constraint names are part of the contract: services
// match on them (e.g. the idempotency unique key), so do not rename them.
//
// PRE-CHECK (needs 1760000200000 applied first):
//     SELECT to_regclass('public.gift_cards');   -- NULL
// VERIFY:
//     \d on each of the five tables shows the constraint names below;
//     SELECT tgname FROM pg_trigger WHERE tgrelid = 'gift_card_transactions'::regclass
//       AND NOT tgisinternal;   -- gift_card_transactions_no_update_delete
//     SELECT table_name, privilege_type FROM information_schema.table_privileges
//      WHERE grantee = '<app role>' AND table_name LIKE 'gift_card%';
//       -- SELECT, INSERT, UPDATE, DELETE on all five tables
// ROLLBACK: down(). Once real cards exist the fix is forward-only.
export class AddGiftCards1760000300000 implements MigrationInterface {
  name = "AddGiftCards1760000300000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);

    await queryRunner.query(`
      CREATE TABLE "gift_card_programs" (
        "id"                       uuid         PRIMARY KEY DEFAULT uuidv7(),
        "tenant_id"                uuid         NOT NULL,
        "name"                     varchar(100) NOT NULL,
        "card_type"                varchar(16)  NOT NULL,
        "currency"                 char(3)      NOT NULL,
        "country"                  char(2)      NOT NULL,
        "region"                   varchar(6),
        "card_number_prefix"       varchar(6)   NOT NULL,
        "card_number_length"       smallint     NOT NULL,
        "pin_required"             boolean      NOT NULL,
        "max_value"                integer      NOT NULL,
        "expiry_months"            smallint,
        "staff_daily_issue_limit"  integer,
        "status"                   varchar(16)  NOT NULL DEFAULT 'active',
        "created_at"               timestamptz  NOT NULL DEFAULT now(),
        "updated_at"               timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "gift_card_programs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id"),
        CONSTRAINT "gift_card_programs_tenant_id_name_key" UNIQUE ("tenant_id", "name"),
        CONSTRAINT "gift_card_programs_id_tenant_id_currency_key" UNIQUE ("id", "tenant_id", "currency"),
        CONSTRAINT "gift_card_programs_card_type_check" CHECK ("card_type" IN ('paid', 'promotional')),
        CONSTRAINT "gift_card_programs_status_check" CHECK ("status" IN ('active', 'retired')),
        CONSTRAINT "gift_card_programs_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
        CONSTRAINT "gift_card_programs_country_check" CHECK ("country" ~ '^[A-Z]{2}$'),
        CONSTRAINT "gift_card_programs_region_check" CHECK ("region" IS NULL OR
          ("region" ~ '^[A-Z]{2}-[A-Z0-9]{1,3}$' AND left("region", 2) = "country")),
        CONSTRAINT "gift_card_programs_prefix_check" CHECK ("card_number_prefix" ~ '^[7-9][0-9]{3,5}$'),
        CONSTRAINT "gift_card_programs_length_check" CHECK ("card_number_length" BETWEEN 16 AND 19),
        CONSTRAINT "gift_card_programs_pinless_length_check" CHECK ("pin_required" OR "card_number_length" = 19),
        CONSTRAINT "gift_card_programs_max_value_check" CHECK ("max_value" > 0),
        CONSTRAINT "gift_card_programs_expiry_check" CHECK ("expiry_months" IS NULL OR
          ("card_type" = 'promotional' AND "expiry_months" BETWEEN 1 AND 120)),
        CONSTRAINT "gift_card_programs_staff_limit_check" CHECK ("staff_daily_issue_limit" IS NULL OR
          ("card_type" = 'paid' AND "staff_daily_issue_limit" > 0))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "gift_cards" (
        "id"                  uuid         PRIMARY KEY DEFAULT uuidv7(),
        "tenant_id"           uuid         NOT NULL,
        "program_id"          uuid         NOT NULL,
        "currency"            char(3)      NOT NULL,
        "reference_number"    char(12)     NOT NULL,
        "card_number_enc"     bytea        NOT NULL,
        "card_number_hmac"    bytea        NOT NULL UNIQUE,
        "card_number_last4"   char(4)      NOT NULL,
        "pin_enc"             bytea,
        "encryption_key_id"   smallint     NOT NULL,
        "lookup_key_id"       smallint     NOT NULL,
        "initial_amount"      integer      NOT NULL,
        "balance"             integer      NOT NULL,
        "status"              varchar(16)  NOT NULL,
        "expires_at"          timestamptz,
        "failed_pin_attempts" smallint     NOT NULL DEFAULT 0,
        "pin_locked_until"    timestamptz,
        "issued_by"           uuid         NOT NULL,
        "created_at"          timestamptz  NOT NULL DEFAULT now(),
        "updated_at"          timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "gift_cards_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id"),
        -- Tenant-consistency guarantee: a card's (tenant, currency) equals its program's.
        -- ON UPDATE NO ACTION also makes the program currency immutable once a card exists.
        CONSTRAINT "gift_cards_program_fkey" FOREIGN KEY ("program_id", "tenant_id", "currency")
          REFERENCES "gift_card_programs" ("id", "tenant_id", "currency"),
        CONSTRAINT "gift_cards_issued_by_fkey" FOREIGN KEY ("issued_by") REFERENCES "users" ("id"),
        CONSTRAINT "gift_cards_tenant_id_reference_number_key" UNIQUE ("tenant_id", "reference_number"),
        CONSTRAINT "gift_cards_id_tenant_id_key" UNIQUE ("id", "tenant_id"),
        CONSTRAINT "gift_cards_id_tenant_id_currency_key" UNIQUE ("id", "tenant_id", "currency"),
        CONSTRAINT "gift_cards_status_check" CHECK ("status" IN ('active', 'suspended', 'depleted', 'voided', 'expired')),
        CONSTRAINT "gift_cards_balance_check" CHECK ("balance" >= 0 AND "balance" <= "initial_amount"),
        CONSTRAINT "gift_cards_initial_amount_check" CHECK ("initial_amount" > 0),
        CONSTRAINT "gift_cards_status_balance_check" CHECK (
             ("status" IN ('active', 'suspended') AND "balance" > 0)
          OR ("status" IN ('depleted', 'voided') AND "balance" = 0)
          OR  "status" = 'expired'),
        CONSTRAINT "gift_cards_hmac_length_check" CHECK (octet_length("card_number_hmac") = 32),
        CONSTRAINT "gift_cards_last4_check" CHECK ("card_number_last4" ~ '^[0-9]{4}$'),
        CONSTRAINT "gift_cards_reference_check" CHECK ("reference_number" ~ '^[0-9A-HJKMNP-TV-Z]{12}$'),
        CONSTRAINT "gift_cards_pin_attempts_check" CHECK ("failed_pin_attempts" BETWEEN 0 AND 10),
        CONSTRAINT "gift_cards_pinless_lockout_check" CHECK ("pin_enc" IS NOT NULL OR
          ("failed_pin_attempts" = 0 AND "pin_locked_until" IS NULL))
      )
    `);
    await queryRunner.query(`CREATE INDEX "gift_cards_program_id_idx" ON "gift_cards" ("program_id")`);

    await queryRunner.query(`
      CREATE TABLE "gift_card_transactions" (
        "id"                      uuid        PRIMARY KEY DEFAULT uuidv7(),
        "tenant_id"               uuid        NOT NULL,
        "gift_card_id"            uuid        NOT NULL,
        "currency"                char(3)     NOT NULL,
        "type"                    varchar(16) NOT NULL,
        "amount"                  integer     NOT NULL,
        "balance_after"           integer     NOT NULL,
        "related_transaction_id"  uuid,
        "idempotency_key"         varchar(64),
        "request_hash"            bytea,
        "external_reference"      varchar(64),
        "actor_user_id"           uuid        NOT NULL,
        "created_at"              timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "gift_card_transactions_card_fkey" FOREIGN KEY ("gift_card_id", "tenant_id", "currency")
          REFERENCES "gift_cards" ("id", "tenant_id", "currency"),
        CONSTRAINT "gift_card_transactions_actor_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users" ("id"),
        CONSTRAINT "gift_card_transactions_tenant_id_idempotency_key_key" UNIQUE ("tenant_id", "idempotency_key"),
        CONSTRAINT "gift_card_transactions_id_gift_card_id_key" UNIQUE ("id", "gift_card_id"),
        CONSTRAINT "gift_card_transactions_related_fkey" FOREIGN KEY ("related_transaction_id", "gift_card_id")
          REFERENCES "gift_card_transactions" ("id", "gift_card_id"),
        CONSTRAINT "gift_card_transactions_type_check" CHECK ("type" IN ('issue', 'redeem', 'refund', 'void')),
        CONSTRAINT "gift_card_transactions_amount_check" CHECK ("amount" > 0),
        CONSTRAINT "gift_card_transactions_balance_after_check" CHECK ("balance_after" >= 0),
        CONSTRAINT "gift_card_transactions_related_check" CHECK (("type" = 'refund') = ("related_transaction_id" IS NOT NULL)),
        CONSTRAINT "gift_card_transactions_idempotency_check" CHECK (
          ("idempotency_key" IS NULL) = ("request_hash" IS NULL)
          AND (("type" = 'void') = ("idempotency_key" IS NULL)))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "gift_card_transactions_gift_card_id_created_at_idx" ON "gift_card_transactions" ("gift_card_id", "created_at")`
    );
    await queryRunner.query(
      `CREATE INDEX "gift_card_transactions_related_transaction_id_idx" ON "gift_card_transactions" ("related_transaction_id")`
    );
    await queryRunner.query(
      `CREATE INDEX "gift_card_transactions_actor_user_id_created_at_idx" ON "gift_card_transactions" ("actor_user_id", "created_at")`
    );

    await queryRunner.query(`
      CREATE FUNCTION "gift_card_transactions_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'gift_card_transactions is append-only' USING ERRCODE = 'restrict_violation';
      END $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "gift_card_transactions_no_update_delete"
        BEFORE UPDATE OR DELETE ON "gift_card_transactions"
        FOR EACH ROW EXECUTE FUNCTION "gift_card_transactions_append_only"()
    `);

    await queryRunner.query(`
      CREATE TABLE "gift_card_deliveries" (
        "id"               uuid         PRIMARY KEY DEFAULT uuidv7(),
        "tenant_id"        uuid         NOT NULL,
        "gift_card_id"     uuid         NOT NULL UNIQUE,
        "recipient_name"   varchar(100) NOT NULL,
        "recipient_email"  varchar(254) NOT NULL,
        "sender_name"      varchar(100) NOT NULL,
        "message"          varchar(500),
        "send_at"          timestamptz  NOT NULL,
        "status"           varchar(16)  NOT NULL DEFAULT 'scheduled',
        "attempts"         smallint     NOT NULL DEFAULT 0,
        "next_attempt_at"  timestamptz  NOT NULL,
        "claimed_at"       timestamptz,
        "last_error"       varchar(64),
        "sent_at"          timestamptz,
        "opened_at"        timestamptz,
        "reveal_count"     integer      NOT NULL DEFAULT 0,
        "last_revealed_at" timestamptz,
        "token_hash"       bytea        UNIQUE,
        "token_expires_at" timestamptz,
        "created_by"       uuid         NOT NULL,
        "created_at"       timestamptz  NOT NULL DEFAULT now(),
        "updated_at"       timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "gift_card_deliveries_card_fkey" FOREIGN KEY ("gift_card_id", "tenant_id")
          REFERENCES "gift_cards" ("id", "tenant_id"),
        CONSTRAINT "gift_card_deliveries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id"),
        CONSTRAINT "gift_card_deliveries_status_check" CHECK ("status" IN ('scheduled', 'sending', 'sent', 'failed', 'cancelled')),
        CONSTRAINT "gift_card_deliveries_attempts_check" CHECK ("attempts" BETWEEN 0 AND 100),
        CONSTRAINT "gift_card_deliveries_reveal_count_check" CHECK ("reveal_count" >= 0),
        CONSTRAINT "gift_card_deliveries_token_pair_check" CHECK (("token_hash" IS NULL) = ("token_expires_at" IS NULL)),
        CONSTRAINT "gift_card_deliveries_token_hash_length_check" CHECK ("token_hash" IS NULL OR octet_length("token_hash") = 32),
        CONSTRAINT "gift_card_deliveries_claimed_check" CHECK (("status" = 'sending') = ("claimed_at" IS NOT NULL)),
        CONSTRAINT "gift_card_deliveries_cancelled_token_check" CHECK ("status" NOT IN ('cancelled', 'failed') OR "token_hash" IS NULL)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "gift_card_deliveries_due_idx" ON "gift_card_deliveries" ("status", "next_attempt_at")`
    );

    // Non-secret key check values (KCV) per configured key id; never the keys themselves
    await queryRunner.query(`
      CREATE TABLE "gift_card_key_checks" (
        "purpose"      varchar(16) NOT NULL,
        "key_id"       smallint    NOT NULL,
        "check_value"  bytea       NOT NULL,
        "created_at"   timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "gift_card_key_checks_pkey" PRIMARY KEY ("purpose", "key_id"),
        CONSTRAINT "gift_card_key_checks_purpose_check" CHECK ("purpose" IN ('encryption', 'lookup')),
        CONSTRAINT "gift_card_key_checks_length_check" CHECK (octet_length("check_value") = 16)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "gift_card_key_checks"`);
    await queryRunner.query(`DROP TABLE "gift_card_deliveries"`);
    // Dropping the table drops its trigger; the function goes after it
    await queryRunner.query(`DROP TABLE "gift_card_transactions"`);
    await queryRunner.query(`DROP FUNCTION "gift_card_transactions_append_only"()`);
    await queryRunner.query(`DROP TABLE "gift_cards"`);
    await queryRunner.query(`DROP TABLE "gift_card_programs"`);
  }
}
