import { randomInt as cryptoRandomInt } from "node:crypto";

export type RandomInt = (max: number) => number;

// Best-effort deny-list of prefixes that belong to payment networks (RuPay 81/82, Troy 9792).
export const NETWORK_DENYLIST_PREFIXES = ["81", "82", "9792"] as const;

export const PIN_LENGTH = 6;

const MIN_PREFIX_LENGTH = 4;
const MAX_PREFIX_LENGTH = 6;
const MIN_NUMBER_LENGTH = 16;
const MAX_NUMBER_LENGTH = 19;
const PINLESS_NUMBER_LENGTH = 19;

// Crockford base32: no I, L, O, U
const REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const REFERENCE_LENGTH = 12;

// crypto.randomInt is uniform (rejection sampling), so there is no modulo bias
const defaultRandomInt: RandomInt = (max) => cryptoRandomInt(max);

/** Every reason a prefix/length/PIN combination cannot be used as a card numbering scheme. */
export function programNumberingProblems(prefix: string, length: number, pinRequired: boolean): string[] {
  const problems: string[] = [];
  if (!/^[0-9]+$/.test(prefix) || prefix.length < MIN_PREFIX_LENGTH || prefix.length > MAX_PREFIX_LENGTH) {
    problems.push(`cardNumberPrefix must be ${MIN_PREFIX_LENGTH} to ${MAX_PREFIX_LENGTH} digits`);
  } else {
    if (!/^[7-9]/.test(prefix)) {
      problems.push("cardNumberPrefix must start with 7, 8 or 9 (outside the banking range)");
    }
    if (NETWORK_DENYLIST_PREFIXES.some((denied) => prefix.startsWith(denied))) {
      problems.push("cardNumberPrefix collides with a payment network prefix");
    }
  }
  if (!Number.isInteger(length) || length < MIN_NUMBER_LENGTH || length > MAX_NUMBER_LENGTH) {
    problems.push(`cardNumberLength must be an integer from ${MIN_NUMBER_LENGTH} to ${MAX_NUMBER_LENGTH}`);
  } else if (!pinRequired && length !== PINLESS_NUMBER_LENGTH) {
    problems.push(`cardNumberLength must be ${PINLESS_NUMBER_LENGTH} when no PIN is required`);
  }
  return problems;
}

/** Luhn check digit to append to `payload` (digits only). */
export function luhnCheckDigit(payload: string): number {
  let sum = 0;
  // The check digit will sit at position 1 (rightmost), so the payload's last digit is doubled
  for (let i = payload.length - 1, double = true; i >= 0; i--, double = !double) {
    let digit = payload.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return (10 - (sum % 10)) % 10;
}

export function isLuhnValid(digits: string): boolean {
  if (!/^[0-9]{2,}$/.test(digits)) return false;
  return luhnCheckDigit(digits.slice(0, -1)) === digits.charCodeAt(digits.length - 1) - 48;
}

/** prefix + random digits + Luhn check digit. Callers validate the scheme first. */
export function generateCardNumber(
  prefix: string,
  length: number,
  randomInt: RandomInt = defaultRandomInt
): string {
  const randomDigits = length - prefix.length - 1;
  if (!/^[0-9]+$/.test(prefix) || !Number.isInteger(length) || randomDigits < 1) {
    throw new RangeError("Invalid card numbering scheme");
  }
  let payload = prefix;
  for (let i = 0; i < randomDigits; i++) payload += String(randomInt(10));
  return payload + String(luhnCheckDigit(payload));
}

/** Strips spaces and hyphens; returns the digits, or null if it is not a valid card number. */
export function normalizeCardNumber(input: string): string | null {
  const digits = input.replace(/[ -]/g, "");
  if (!/^[0-9]{16,19}$/.test(digits)) return null;
  return isLuhnValid(digits) ? digits : null;
}

export function generatePin(randomInt: RandomInt = defaultRandomInt): string {
  let pin = "";
  for (let i = 0; i < PIN_LENGTH; i++) pin += String(randomInt(10));
  return pin;
}

/** 12 Crockford base32 characters (60 bits). Authorizes nothing; unique per tenant. */
export function generateReferenceNumber(randomInt: RandomInt = defaultRandomInt): string {
  let ref = "";
  for (let i = 0; i < REFERENCE_LENGTH; i++) ref += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  return ref;
}

/** Uppercases, strips hyphens, maps O->0 and I/L->1; null if the result is not a reference. */
export function normalizeReferenceNumber(input: string): string | null {
  const ref = input
    .toUpperCase()
    .replace(/-/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{12}$/.test(ref) ? ref : null;
}
