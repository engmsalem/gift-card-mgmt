import { Entity, PrimaryColumn, Check, Column, CreateDateColumn, ManyToOne, JoinColumn, Index } from "typeorm";
import { User } from "./user";

export type RevokeReason = "rotated" | "logout" | "reuse" | "evicted";

// Only the SHA-256 hash of the opaque refresh token is stored (see src/tokens.ts).
@Entity("refresh_tokens")
@Check("refresh_tokens_revoke_reason_check", `"revoke_reason" IN ('rotated', 'logout', 'reuse', 'evicted')`)
@Check("refresh_tokens_revoked_reason_pair_check", `("revoked_at" IS NULL) = ("revoke_reason" IS NULL)`)
export class RefreshToken {
  @PrimaryColumn({ type: "uuid", default: () => "uuidv7()" })
  id: string;

  @Index("refresh_tokens_user_id_idx")
  @Column({ name: "user_id", type: "uuid" })
  userId: string;

  @ManyToOne(() => User, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id", foreignKeyConstraintName: "refresh_tokens_user_id_fkey" })
  user: User;

  @Column({ name: "token_hash", type: "char", length: 64, unique: true })
  tokenHash: string;

  @Column({ name: "expires_at", type: "timestamptz" })
  expiresAt: Date;

  @Column({ name: "revoked_at", type: "timestamptz", nullable: true })
  revokedAt: Date | null;

  // Why revoked_at was set; NULL exactly while the token is active. Only "rotated" tokens can
  // signal theft when presented again (see AuthService.refresh).
  @Column({ name: "revoke_reason", type: "varchar", length: 16, nullable: true })
  revokeReason: RevokeReason | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
