import { createHash, randomBytes } from "crypto";

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
// Active (unrevoked, unexpired) refresh tokens kept per user; the oldest beyond this are evicted.
export const MAX_ACTIVE_REFRESH_TOKENS = 10;
// Expiry is computed by the database so that it and every `expires_at > now()` check share
// one clock. Built from the numeric constant above, so it is not injectable.
export const REFRESH_TOKEN_EXPIRES_AT_SQL = `now() + interval '${REFRESH_TOKEN_TTL_SECONDS} seconds'`;

/** Opaque refresh token: 32 random bytes, base64url (43 chars). */
export function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Only this hash is stored; the raw token is never persisted. */
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
