import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";

export const DELIVERY_TOKEN_TTL_DAYS = 90;
// Expiry is computed by the database so that it and every `token_expires_at > now()` check share one clock
export const DELIVERY_TOKEN_EXPIRES_AT_SQL = `now() + interval '${DELIVERY_TOKEN_TTL_DAYS} days'`;

const TOKEN_BYTES = 32;

/** Opaque delivery token: 32 random bytes, base64url (43 chars). Only its hash is stored. */
export function generateDeliveryToken(randomBytes: (n: number) => Buffer = cryptoRandomBytes): string {
  const bytes = randomBytes(TOKEN_BYTES);
  if (bytes.length !== TOKEN_BYTES) throw new RangeError("Invalid token entropy length");
  return bytes.toString("base64url");
}

/** SHA-256 of the raw token (32 bytes), the value stored in token_hash. */
export function hashDeliveryToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** The token travels in the URL fragment, which browsers never send to a server. */
export function buildDeliveryLink(baseUrl: string, token: string): string {
  return `${baseUrl}#token=${token}`;
}
