import { createHash, randomBytes } from "crypto";

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Opaque refresh token: 32 random bytes, base64url (43 chars). */
export function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Only this hash is stored; the raw token is never persisted. */
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
