import { Column, CreateDateColumn, Entity, ForeignKey, Index, PrimaryColumn } from "typeorm";
import { Tenant } from "./tenant";
import { User } from "./user";

// Append-only (trigger from 1760000400000-AuditLogsAppendOnly). Rows are written inside the
// transaction of the change they record. The table predates this entity (InitialSchema).
@Entity("audit_logs")
@ForeignKey(() => Tenant, ["tenantId"], ["id"], { name: "audit_logs_tenant_id_fkey" })
@ForeignKey(() => User, ["userId"], ["id"], { name: "audit_logs_user_id_fkey" })
export class AuditLog {
  @PrimaryColumn({ type: "uuid", default: () => "uuidv7()" })
  id: string;

  @Index("audit_logs_tenant_id_idx")
  @Column({ name: "tenant_id", type: "uuid", nullable: true })
  tenantId: string | null;

  @Column({ type: "varchar", length: 100 })
  action: string;

  @Index("audit_logs_user_id_idx")
  @Column({ name: "user_id", type: "uuid", nullable: true })
  userId: string | null;

  @Column({ type: "jsonb", nullable: true })
  details: Record<string, unknown> | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
