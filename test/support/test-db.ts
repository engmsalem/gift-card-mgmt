// Pure helpers that decide which database integration tests may touch. Kept free of any
// DB or src/ import so the safety logic is unit-testable.

const TEST_SUFFIX = "_test";

/**
 * Name of the database integration tests must use: TEST_DB_DATABASE if set (explicit
 * choice, e.g. CI), otherwise `${DB_DATABASE}_test`.
 */
export function resolveTestDatabase(env: Record<string, string | undefined>): string {
  if (env.TEST_DB_DATABASE) return env.TEST_DB_DATABASE;
  if (!env.DB_DATABASE) {
    throw new Error(
      "Cannot determine the test database: set DB_DATABASE (the test DB is DB_DATABASE + '_test') or TEST_DB_DATABASE"
    );
  }
  return `${env.DB_DATABASE}${TEST_SUFFIX}`;
}

/**
 * Refuses to proceed against a database whose name does not end in `_test`, unless the
 * name was chosen explicitly via TEST_DB_DATABASE. Guards destructive test helpers.
 */
export function assertTestDatabase(
  database: string | undefined,
  env: Record<string, string | undefined>
): void {
  if (env.TEST_DB_DATABASE && database === env.TEST_DB_DATABASE) return;
  if (!database || !database.endsWith(TEST_SUFFIX)) {
    throw new Error(
      `Refusing to run destructive test helpers against database "${database}": its name must end in "${TEST_SUFFIX}" (or be set explicitly via TEST_DB_DATABASE)`
    );
  }
}
