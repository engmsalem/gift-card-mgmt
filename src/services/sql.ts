import type { EntityManager } from "typeorm";

/**
 * Runs a statement and returns its rows whatever the statement kind. TypeORM's `em.query` returns
 * plain rows for SELECT and INSERT, but `[rows, rowCount]` for UPDATE and DELETE (even with
 * RETURNING); this hides that difference so callers always get `T[]`.
 */
export async function returningRows<T>(em: EntityManager, sql: string, params: unknown[] = []): Promise<T[]> {
  const result: unknown = await em.query(sql, params);
  if (!Array.isArray(result)) {
    throw new Error("returningRows: unexpected query result shape");
  }
  // Rows are objects, so a two-element array whose first element is an array is the UPDATE/DELETE shape
  if (result.length === 2 && Array.isArray(result[0]) && typeof result[1] === "number") {
    return result[0] as T[];
  }
  return result as T[];
}

/**
 * The constraint name of a PostgreSQL unique violation (`23505`), or null for any other error.
 * TypeORM's QueryFailedError copies the driver error's fields onto itself and keeps the original
 * under `driverError`, so both are read.
 */
export function uniqueViolationConstraint(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { code?: unknown; constraint?: unknown; driverError?: { code?: unknown; constraint?: unknown } };
  if (e.code !== "23505" && e.driverError?.code !== "23505") return null;
  const constraint = e.constraint ?? e.driverError?.constraint;
  return typeof constraint === "string" ? constraint : null;
}
