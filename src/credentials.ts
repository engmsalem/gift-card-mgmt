import bcrypt from "bcrypt";
import { isEmail } from "class-validator";
import { BadRequestError } from "./errors";

export const BCRYPT_COST = 10;
const MAX_PASSWORD_BYTES = 72; // bcrypt ignores everything past 72 bytes

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function assertValidEmail(email: string): void {
  if (!isEmail(email)) {
    throw new BadRequestError("Invalid email address");
  }
}

/** Length in characters is checked by the route schema; bytes are checked here. */
export function assertPasswordFitsBcrypt(password: string): void {
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    throw new BadRequestError("Password must be at most 72 bytes");
  }
}

/**
 * Validates signup credentials and returns the normalized email to store and look up.
 * Hashing is separate (hashPassword) so callers can run cheap conflict checks first.
 */
export function prepareCredentials(email: string, password: string): string {
  const normalized = normalizeEmail(email);
  assertValidEmail(normalized);
  assertPasswordFitsBcrypt(password);
  return normalized;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}
