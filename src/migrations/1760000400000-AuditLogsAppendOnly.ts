import { MigrationInterface, QueryRunner } from "typeorm";

// audit_logs becomes append-only: any UPDATE or DELETE (even by the owner role) is rejected.
// TRUNCATE is not a row operation and is not blocked (test resets rely on that).
//
// PRE-CHECK: none needed (adds a trigger only; no existing row is touched).
// VERIFY:
//     SELECT tgname FROM pg_trigger WHERE tgrelid = 'audit_logs'::regclass AND NOT tgisinternal;
//       -- audit_logs_no_update_delete
// ROLLBACK: down() drops the trigger and function. Safe at any time.
export class AuditLogsAppendOnly1760000400000 implements MigrationInterface {
  name = "AuditLogsAppendOnly1760000400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`
      CREATE FUNCTION "audit_logs_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = 'restrict_violation';
      END $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "audit_logs_no_update_delete"
        BEFORE UPDATE OR DELETE ON "audit_logs"
        FOR EACH ROW EXECUTE FUNCTION "audit_logs_append_only"()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER "audit_logs_no_update_delete" ON "audit_logs"`);
    await queryRunner.query(`DROP FUNCTION "audit_logs_append_only"()`);
  }
}
