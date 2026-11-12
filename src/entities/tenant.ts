import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";
import { bigintTransformer } from "./transformers";

@Entity("tenants")
export class Tenant {
  @PrimaryColumn({
    type: "bigint",
    generated: "identity",
    generatedIdentity: "BY DEFAULT",
    transformer: bigintTransformer,
  })
  id: number;

  @Column({ type: "varchar", length: 100 })
  name: string;

  @Column({ type: "varchar", length: 50, unique: true })
  subdomain: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
