import { FastifyInstance } from "fastify";
import bcrypt from "bcrypt";
import { randomBytes } from "crypto";
import { EntityManager, ObjectLiteral, Repository } from "typeorm";
import { RefreshToken, RevokeReason } from "../entities/refresh-token";
import { User } from "../entities/user";
import { UnauthorizedError } from "../errors";
import { BCRYPT_COST, normalizeEmail } from "../credentials";
import { ACCESS_TOKEN_TYPE } from "../plugins/jwt";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  MAX_ACTIVE_REFRESH_TOKENS,
  REFRESH_TOKEN_EXPIRES_AT_SQL,
  generateRefreshToken,
  hashRefreshToken,
} from "../tokens";

// Hash of a throwaway string, computed once with the same cost as real hashes. Compared
// against when the email is unknown so that unknown-email and wrong-password logins take
// the same time (and keep doing so if BCRYPT_COST changes). Started at import with the async
// hash, so it runs in the libuv threadpool rather than blocking the event loop at startup.
const DUMMY_HASH: Promise<string> = bcrypt.hash(randomBytes(16).toString("hex"), BCRYPT_COST);

// A rotated token presented again within this window is a benign race (two tabs, a client
// retry) and is only rejected; after it, reuse is treated as theft.
export const REFRESH_REUSE_GRACE_SECONDS = 10;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export class AuthService {
  private userRepository: Repository<User>;
  private tokenRepository: Repository<RefreshToken>;

  constructor(private app: FastifyInstance) {
    this.userRepository = app.db.getRepository(User);
    this.tokenRepository = app.db.getRepository(RefreshToken);
  }

  async login(email: string, password: string): Promise<TokenPair> {
    // passwordHash is `select: false`, so request it explicitly
    const user = await this.userRepository.findOne({
      where: { email: normalizeEmail(email) },
      select: { id: true, tenantId: true, role: true, passwordHash: true },
    });

    const valid = await bcrypt.compare(password, user?.passwordHash ?? (await DUMMY_HASH));
    if (!user || !valid) {
      throw new UnauthorizedError("Invalid email or password");
    }
    return this.app.db.transaction((em) => this.issueTokens(em, user));
  }

  /**
   * Rotates a refresh token. Revoking the presented token, reading the user and issuing the
   * new pair happen in one transaction, so a failure leaves the old token usable. Presenting
   * a token that was rotated longer ago than the grace window is treated as theft and revokes
   * all of the user's tokens (committed, then rejected). Tokens revoked for any other reason
   * (logout, eviction, an earlier theft response) or expired are only rejected.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const tokenHash = hashRefreshToken(refreshToken);

    const pair = await this.app.db.transaction(async (em) => {
      const rows = await this.revoke(
        "token_hash = :tokenHash AND revoked_at IS NULL AND expires_at > now()",
        { tokenHash },
        "rotated",
        em
      );

      if (rows.length === 0) {
        await this.revoke(
          `revoked_at IS NULL AND user_id IN (
             SELECT user_id FROM refresh_tokens
             WHERE token_hash = :tokenHash
               AND revoke_reason = 'rotated'
               AND revoked_at < now() - interval '${REFRESH_REUSE_GRACE_SECONDS} seconds'
           )`,
          { tokenHash },
          "reuse",
          em
        );
        return null;
      }

      // Role and tenant are re-read so changes apply on the next refresh
      const user = await em.findOneBy(User, { id: rows[0].user_id });
      return user ? this.issueTokens(em, user) : null;
    });

    if (!pair) throw new UnauthorizedError("Invalid or expired refresh token");
    return pair;
  }

  /** Idempotent: unknown or already revoked tokens are not an error (and not an oracle). */
  async logout(refreshToken: string): Promise<void> {
    await this.revoke(
      "token_hash = :tokenHash AND revoked_at IS NULL",
      { tokenHash: hashRefreshToken(refreshToken) },
      "logout"
    );
  }

  /** Marks matching, still-active tokens revoked; returns the affected rows' user ids. */
  private async revoke(
    where: string,
    params: ObjectLiteral,
    reason: RevokeReason,
    em: EntityManager = this.app.db.manager
  ): Promise<{ user_id: string }[]> {
    const result = await em
      .createQueryBuilder()
      .update(RefreshToken)
      .set({ revokedAt: () => "now()", revokeReason: reason })
      .where(where, params)
      .returning("user_id")
      .execute();
    return result.raw as { user_id: string }[];
  }

  private async issueTokens(
    em: EntityManager,
    user: Pick<User, "id" | "tenantId" | "role">
  ): Promise<TokenPair> {
    const accessToken = this.app.jwt.sign({
      sub: user.id,
      tid: user.tenantId,
      role: user.role,
      typ: ACCESS_TOKEN_TYPE,
    });

    // Housekeeping so the table does not grow forever. Revoked-but-unexpired rows stay:
    // reuse detection needs them.
    await em
      .createQueryBuilder()
      .delete()
      .from(RefreshToken)
      .where("user_id = :userId AND expires_at < now()", { userId: user.id })
      .execute();

    const refreshToken = generateRefreshToken();
    await em.insert(RefreshToken, {
      userId: user.id,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: () => REFRESH_TOKEN_EXPIRES_AT_SQL,
    });

    // Cap concurrent sessions: evict the user's oldest active tokens beyond the limit. Evicted
    // tokens are rejected like any logged-out token and do not trigger theft handling.
    // FOR UPDATE SKIP LOCKED: never wait on rows another transaction holds (two concurrent
    // issues for one user would otherwise lock overlapping rows in different orders and
    // deadlock). Locked rows are dropped before OFFSET counts, so a locked row among the
    // newest ones shifts the window and fewer tokens are evicted than ideal, never one of the
    // newest MAX_ACTIVE_REFRESH_TOKENS; the cap converges on the next issue.
    await this.revoke(
      `id IN (
         SELECT id FROM refresh_tokens
         WHERE user_id = :userId AND revoked_at IS NULL AND expires_at > now()
         ORDER BY created_at DESC, id DESC
         OFFSET ${MAX_ACTIVE_REFRESH_TOKENS}
         FOR UPDATE SKIP LOCKED
       )`,
      { userId: user.id },
      "evicted",
      em
    );

    return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
  }
}
