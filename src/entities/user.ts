import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { Role } from "../enums/roles";
import { IsEmail } from "class-validator";
import ExtendedBaseEntity from "./extended-base-entity";
import { Tenant } from "./tenant";
import { bigintTransformer } from "./transformers";

// Table and column names follow src/migrations (plural table, snake_case columns).
// "user" is a reserved word in PostgreSQL, so the table is "users".
@Entity("users")
export class User extends ExtendedBaseEntity {
  @PrimaryColumn({
    type: "bigint",
    generated: "identity",
    generatedIdentity: "BY DEFAULT",
    transformer: bigintTransformer,
  })
  id: number;

  @Index("users_tenant_id_idx")
  @Column({ name: "tenant_id", type: "bigint", transformer: bigintTransformer })
  tenantId: number;

  @ManyToOne(() => Tenant, { nullable: false })
  @JoinColumn({ name: "tenant_id", foreignKeyConstraintName: "users_tenant_id_fkey" })
  tenant: Tenant;

  @Column({ type: "varchar", length: 100 })
  name: string;

  @Column({ type: "varchar", length: 150, unique: true })
  @IsEmail()
  email: string;

  // select: false keeps the hash out of every query unless it is explicitly selected
  @Column({ name: "password_hash", type: "varchar", length: 255, select: false })
  passwordHash: string;

  @Column({ type: "enum", enum: Role, enumName: "user_role", default: Role.STAFF })
  role: Role;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
