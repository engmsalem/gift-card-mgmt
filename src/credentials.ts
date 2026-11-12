import { isEmail } from "class-validator";
import { BadRequestError } from "./errors";

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
