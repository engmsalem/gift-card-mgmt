import { programNumberingProblems } from "./card-number";
import { isSupportedCountry, isSupportedCurrency, isValidRegion } from "./money";

export type CardType = "paid" | "promotional";
export type ProgramStatus = "active" | "retired";

export const MAX_PROGRAM_AMOUNT = 2_000_000_000;
export const MAX_EXPIRY_MONTHS = 120;

/** A validated program definition, with absent optionals normalized to null. */
export interface ProgramDefinition {
  name: string;
  cardType: CardType;
  currency: string;
  country: string;
  region: string | null;
  cardNumberPrefix: string;
  cardNumberLength: number;
  pinRequired: boolean;
  maxValue: number;
  expiryMonths: number | null;
  staffDailyIssueLimit: number | null;
}

/** Shape checked at the edge (Ajv); the optional fields may be absent or null. */
export type ProgramDefinitionInput = Omit<ProgramDefinition, "region" | "expiryMonths" | "staffDailyIssueLimit"> & {
  region?: string | null;
  expiryMonths?: number | null;
  staffDailyIssueLimit?: number | null;
};

export type ProgramState = ProgramDefinition & { status: ProgramStatus };

export type ProgramPatch = Partial<ProgramState>;

export type ProgramFieldValue = string | number | boolean | null;

export interface ProgramChange {
  field: keyof ProgramState;
  from: ProgramFieldValue;
  to: ProgramFieldValue;
}

/** Fields that cannot change once the first card has been issued. */
export const IMMUTABLE_AFTER_ISSUE = [
  "cardType",
  "currency",
  "country",
  "region",
  "cardNumberPrefix",
  "cardNumberLength",
] as const satisfies readonly (keyof ProgramState)[];

export type ProgramDefinitionResult =
  | { ok: true; value: ProgramDefinition }
  | { ok: false; problems: string[] };

export type ProgramUpdateResult =
  | { ok: true; value: ProgramState; changes: ProgramChange[] }
  // Non-empty `immutableFields` means the update is a state conflict (409) rather than a bad value (400)
  | { ok: false; problems: string[]; immutableFields: string[] };

function isIntegerBetween(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function definitionProblems(def: ProgramDefinition): string[] {
  const problems: string[] = [];

  if (!isSupportedCurrency(def.currency)) problems.push("currency is not supported");
  if (!isSupportedCountry(def.country)) problems.push("country is not supported");
  if (def.region !== null && !isValidRegion(def.region, def.country)) {
    problems.push("region must be an ISO 3166-2 code within the program's country");
  }
  problems.push(...programNumberingProblems(def.cardNumberPrefix, def.cardNumberLength, def.pinRequired));
  if (!isIntegerBetween(def.maxValue, 1, MAX_PROGRAM_AMOUNT)) {
    problems.push(`maxValue must be an integer from 1 to ${MAX_PROGRAM_AMOUNT}`);
  }
  if (def.expiryMonths !== null) {
    if (def.cardType !== "promotional") {
      problems.push("expiryMonths is allowed only on promotional programs");
    } else if (!isIntegerBetween(def.expiryMonths, 1, MAX_EXPIRY_MONTHS)) {
      problems.push(`expiryMonths must be an integer from 1 to ${MAX_EXPIRY_MONTHS}`);
    }
  }
  if (def.staffDailyIssueLimit !== null) {
    if (def.cardType !== "paid") {
      problems.push("staffDailyIssueLimit is allowed only on paid programs");
    } else if (!isIntegerBetween(def.staffDailyIssueLimit, 1, MAX_PROGRAM_AMOUNT)) {
      problems.push(`staffDailyIssueLimit must be an integer from 1 to ${MAX_PROGRAM_AMOUNT}`);
    }
  }
  return problems;
}

export function validateProgramDefinition(input: ProgramDefinitionInput): ProgramDefinitionResult {
  const value: ProgramDefinition = {
    name: input.name,
    cardType: input.cardType,
    currency: input.currency,
    country: input.country,
    region: input.region ?? null,
    cardNumberPrefix: input.cardNumberPrefix,
    cardNumberLength: input.cardNumberLength,
    pinRequired: input.pinRequired,
    maxValue: input.maxValue,
    expiryMonths: input.expiryMonths ?? null,
    staffDailyIssueLimit: input.staffDailyIssueLimit ?? null,
  };
  const problems = definitionProblems(value);
  return problems.length === 0 ? { ok: true, value } : { ok: false, problems };
}

const STATE_FIELDS = [
  "name",
  "cardType",
  "currency",
  "country",
  "region",
  "cardNumberPrefix",
  "cardNumberLength",
  "pinRequired",
  "maxValue",
  "expiryMonths",
  "staffDailyIssueLimit",
  "status",
] as const satisfies readonly (keyof ProgramState)[];

/**
 * Applies `patch` to `current` and re-validates the result as a whole. Immutable fields may
 * change only while `hasIssuedCards` is false. A patch value equal to the current one is not a change.
 */
export function validateProgramUpdate(
  current: ProgramState,
  patch: ProgramPatch,
  hasIssuedCards: boolean
): ProgramUpdateResult {
  const changes: ProgramChange[] = [];
  const next: Record<string, ProgramFieldValue> = { ...current };
  for (const field of STATE_FIELDS) {
    const to = patch[field];
    if (to === undefined || to === current[field]) continue;
    next[field] = to;
    changes.push({ field, from: current[field], to });
  }
  if (changes.length === 0) {
    return { ok: false, problems: ["the update must change at least one field"], immutableFields: [] };
  }

  const immutableFields: string[] = hasIssuedCards
    ? changes.map((c) => c.field).filter((f) => (IMMUTABLE_AFTER_ISSUE as readonly string[]).includes(f))
    : [];
  if (immutableFields.length > 0) {
    return { ok: false, problems: immutableFields.map((f) => `${f} cannot change once cards are issued`), immutableFields };
  }

  const value = next as unknown as ProgramState;
  const problems = definitionProblems(value);
  if (value.status !== "active" && value.status !== "retired") problems.push("status must be active or retired");
  return problems.length === 0 ? { ok: true, value, changes } : { ok: false, problems, immutableFields: [] };
}
