import { Entity, PrimaryColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Index } from "typeorm";
import { bigintTransformer } from "./transformers";
import { User } from "./user";

// Only the SHA-256 hash of the opaque refresh token is stored (see src/tokens.ts).
@Entity("refresh_tokens")
export class RefreshToken {
  @PrimaryColumn({
    type: "bigint",
    generated: "identity",
    generatedIdentity: "BY DEFAULT",
    transformer: bigintTransformer,
  })
  id: number;

  @Index("refresh_tokens_user_id_idx")
  @Column({ name: "user_id", type: "bigint", transformer: bigintTransformer })
  userId: number;

  @ManyToOne(() => User, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id", foreignKeyConstraintName: "refresh_tokens_user_id_fkey" })
  user: User;

  @Column({ name: "token_hash", type: "char", length: 64, unique: true })
  tokenHash: string;

  @Column({ name: "expires_at", type: "timestamptz" })
  expiresAt: Date;

  @Column({ name: "revoked_at", type: "timestamptz", nullable: true })
  revokedAt: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
