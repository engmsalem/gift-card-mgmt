import { FastifyInstance } from "fastify";
import bcrypt from "bcrypt";
import { Repository } from "typeorm";
import { RefreshToken } from "../entities/refresh-token";
import { User } from "../entities/user";
import { UnauthorizedError } from "../errors";
import { normalizeEmail } from "../credentials";
import { ACCESS_TOKEN_TYPE } from "../plugins/jwt";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_MS,
  generateRefreshToken,
  hashRefreshToken,
} from "../tokens";

// bcrypt hash of a throwaway string. Compared against when the email is unknown so that
// unknown-email and wrong-password logins take the same time.
const DUMMY_HASH = "$2b$10$AlPljfVmB4h2lY.yVrn99estwLM1wVtO8bJvn4qM6nj.Lz3UePL/6";

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

    const valid = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !valid) {
      throw new UnauthorizedError("Invalid email or password");
    }
    return this.issueTokens(user);
  }

  /**
   * Rotates a refresh token. The presented token is revoked atomically; presenting a token
   * that was already revoked is treated as theft and revokes all of the user's tokens.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const tokenHash = hashRefreshToken(refreshToken);

    const result = await this.tokenRepository
      .createQueryBuilder()
      .update()
      .set({ revokedAt: () => "now()" })
      .where("token_hash = :tokenHash AND revoked_at IS NULL AND expires_at > now()", {
        tokenHash,
      })
      .returning("user_id")
      .execute();
    const rows = result.raw as { user_id: string }[];

    if (rows.length === 0) {
      const existing = await this.tokenRepository.findOneBy({ tokenHash });
      if (existing?.revokedAt) {
        await this.revokeAllForUser(existing.userId);
      }
      throw new UnauthorizedError("Invalid or expired refresh token");
    }

    // Role and tenant are re-read so changes apply on the next refresh
    const user = await this.userRepository.findOneBy({ id: rows[0].user_id });
    if (!user) {
      throw new UnauthorizedError("Invalid or expired refresh token");
    }
    return this.issueTokens(user);
  }

  /** Idempotent: unknown or already revoked tokens are not an error (and not an oracle). */
  async logout(refreshToken: string): Promise<void> {
    await this.tokenRepository
      .createQueryBuilder()
      .update()
      .set({ revokedAt: () => "now()" })
      .where("token_hash = :tokenHash AND revoked_at IS NULL", {
        tokenHash: hashRefreshToken(refreshToken),
      })
      .execute();
  }

  private async revokeAllForUser(userId: string): Promise<void> {
    await this.tokenRepository
      .createQueryBuilder()
      .update()
      .set({ revokedAt: () => "now()" })
      .where("user_id = :userId AND revoked_at IS NULL", { userId })
      .execute();
  }

  private async issueTokens(user: Pick<User, "id" | "tenantId" | "role">): Promise<TokenPair> {
    const accessToken = this.app.jwt.sign({
      sub: user.id,
      tid: user.tenantId,
      role: user.role,
      typ: ACCESS_TOKEN_TYPE,
    });

    const refreshToken = generateRefreshToken();
    await this.tokenRepository.insert({
      userId: user.id,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    });

    return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
  }
}
