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
