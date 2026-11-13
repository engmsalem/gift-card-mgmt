import type { EntityManager } from "typeorm";
import { AuditLog } from "../entities/audit-log";

type AuditValue = string | number | boolean | null;

// One member per audited action. `details` is typed per action and has no field that could hold a
// secret (card number, PIN, token) or an unmasked email.
export type AuditEntry =
  | { action: "gift_card_program.created"; details: { programId: string } }
  | {
      action: "gift_card_program.updated";
      details: { programId: string; changes: { field: string; from: AuditValue; to: AuditValue }[] };
    };

/**
 * Appends an audit row using the caller's entity manager, so it commits or rolls back with the
 * change it records. Call it inside the transaction.
 */
export async function writeAudit(
  em: EntityManager,
  ctx: { tenantId: string; userId: string | null },
  entry: AuditEntry
): Promise<void> {
  await em.insert(AuditLog, {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    action: entry.action,
    details: entry.details,
  });
}
