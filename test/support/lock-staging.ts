// Helpers for staging lock contention deterministically: hold a transaction open on a dedicated
// admin connection, fire the requests that must block behind it, wait until PostgreSQL reports
// them blocked, then commit. No sleeps stand in for ordering.
import type { QueryRunner } from "typeorm";
import { getAdminDataSource } from "../integration/helpers";

/** Runs one statement on the admin pool (the shape of `adminQuery` in test/integration/helpers.ts). */
export type AdminQuery = (sql: string, params?: unknown[]) => Promise<unknown>;

/**
 * Resolves once at least `n` other backends of this database are waiting on a lock
 * (`wait_event_type = 'Lock'`: row locks, advisory locks and transaction-id waits all count).
 * Stage waiters one at a time: fire a request, `waitUntilBlocked(adminQuery, k)`, fire the next.
 * Rejects after `timeoutMs` so a request that never blocks fails the test instead of hanging it.
 */
export async function waitUntilBlocked(
  adminQuery: AdminQuery,
  n: number,
  { timeoutMs = 5000, pollMs = 10 }: { timeoutMs?: number; pollMs?: number } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let blocked = 0;
  for (;;) {
    const rows = (await adminQuery(
      `SELECT count(*)::int AS blocked
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'`
    )) as { blocked: number }[];
    blocked = rows[0].blocked;
    if (blocked >= n) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${n} blocked backend(s); saw ${blocked}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export interface AdminTransaction {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  /** Commits and releases the connection. */
  commit(): Promise<void>;
  /** Rolls back and releases the connection. A no-op after commit or a previous rollback, so it is safe in `finally`. */
  rollback(): Promise<void>;
}

/**
 * Opens a transaction on a dedicated admin connection (a `QueryRunner`) and keeps it open until
 * `commit()` or `rollback()`. `adminQuery` runs every statement on the pool, so it cannot hold a
 * transaction across calls; use this when a test must hold locks or uncommitted rows.
 */
export async function openAdminTransaction(): Promise<AdminTransaction> {
  const admin = getAdminDataSource();
  if (!admin.isInitialized) await admin.initialize();
  const runner: QueryRunner = admin.createQueryRunner();
  await runner.connect();
  try {
    await runner.startTransaction();
  } catch (err) {
    await runner.release();
    throw err;
  }
  let finished = false;
  return {
    query: (sql, params = []) => runner.query(sql, params) as Promise<unknown>,
    commit: async () => {
      if (finished) throw new Error("admin transaction already finished");
      finished = true;
      try {
        await runner.commitTransaction();
      } finally {
        await runner.release();
      }
    },
    rollback: async () => {
      if (finished) return;
      finished = true;
      try {
        await runner.rollbackTransaction();
      } finally {
        await runner.release();
      }
    },
  };
}
