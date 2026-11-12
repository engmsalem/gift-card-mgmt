import { MigrationInterface, QueryRunner } from "typeorm";

export class AddRefreshTokens1760000100000 implements MigrationInterface {
  name = "AddRefreshTokens1760000100000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "refresh_tokens" (
        "id"          uuid PRIMARY KEY DEFAULT uuidv7(),
        "user_id"     uuid        NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
        "token_hash"  char(64)    NOT NULL UNIQUE,
        "expires_at"  timestamptz NOT NULL,
        "revoked_at"  timestamptz,
        "revoke_reason" varchar(16),
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "refresh_tokens_revoke_reason_check"
          CHECK ("revoke_reason" IN ('rotated', 'logout', 'reuse', 'evicted')),
        CONSTRAINT "refresh_tokens_revoked_reason_pair_check"
          CHECK (("revoked_at" IS NULL) = ("revoke_reason" IS NULL))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens" ("user_id")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "refresh_tokens"`);
  }
}
