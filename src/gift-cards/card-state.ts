import { timingSafeEqual } from "node:crypto";
import type { CardType, ProgramStatus } from "./program-rules";

export type CardStatus = "active" | "suspended" | "depleted" | "voided" | "expired";
export type Caller = "admin" | "staff";

export const PIN_MAX_FAILED_ATTEMPTS = 5;
export const PIN_LOCK_MINUTES = 30;

/** What the deciders need to know about a card; `isExpired` is computed in SQL from the DB clock. */
export interface CardSnapshot {
  status: CardStatus;
  balance: number;
  isExpired: boolean;
}

/** Stored status, except that a card past its expiry is 'expired' unless it is voided. */
export function effectiveStatus(card: Pick<CardSnapshot, "status" | "isExpired">): CardStatus {
  if (card.status === "voided") return "voided";
  return card.isExpired ? "expired" : card.status;
}

export type Rejection = "expired" | "not_active";

// Rejection messages, defined once: clients and the identical-404 behaviour depend on the exact text
export const CARD_EXPIRED_MESSAGE = "Card has expired";
export const CARD_NOT_ACTIVE_MESSAGE = "Card is not active";
export const CARD_VOIDED_MESSAGE = "Card is voided";
export const INSUFFICIENT_BALANCE_MESSAGE = "Insufficient balance";

function rejectionFor(status: CardStatus): Rejection {
  return status === "expired" ? "expired" : "not_active";
}

// ---- issue ----

export interface IssueProgram {
  status: ProgramStatus;
  cardType: CardType;
  maxValue: number;
  staffDailyIssueLimit: number | null;
}

export type IssueDecision =
  // `staffLimit` is set for staff callers: the caller must still check the rolling 24h total in SQL
  | { ok: true; staffLimit: number | null }
  | { ok: false; reason: "program_retired" | "promotional_requires_admin" | "amount_above_max" | "no_staff_limit" };

export function decideIssue(program: IssueProgram, caller: Caller, amount: number): IssueDecision {
  if (program.status === "retired") return { ok: false, reason: "program_retired" };
  if (caller === "staff" && program.cardType === "promotional") {
    return { ok: false, reason: "promotional_requires_admin" };
  }
  if (amount > program.maxValue) return { ok: false, reason: "amount_above_max" };
  if (caller === "staff") {
    if (program.staffDailyIssueLimit === null) return { ok: false, reason: "no_staff_limit" };
    return { ok: true, staffLimit: program.staffDailyIssueLimit };
  }
  return { ok: true, staffLimit: null };
}

// ---- redeem / refund ----

export type RedeemDecision =
  | { ok: true; newBalance: number; newStatus: "active" | "depleted" }
  | { ok: false; reason: Rejection | "insufficient_balance" };

export function decideRedeem(card: CardSnapshot, amount: number): RedeemDecision {
  const status = effectiveStatus(card);
  if (status !== "active") return { ok: false, reason: rejectionFor(status) };
  if (amount > card.balance) return { ok: false, reason: "insufficient_balance" };
  const newBalance = card.balance - amount;
  return { ok: true, newBalance, newStatus: newBalance === 0 ? "depleted" : "active" };
}

export type RefundDecision =
  | { ok: true; newBalance: number; newStatus: "active" }
  | { ok: false; reason: Rejection };

/** Whether the refund is within what the redeem took is checked in SQL, not here. */
export function decideRefund(card: CardSnapshot, amount: number): RefundDecision {
  const status = effectiveStatus(card);
  if (status !== "active" && status !== "depleted") return { ok: false, reason: rejectionFor(status) };
  return { ok: true, newBalance: card.balance + amount, newStatus: "active" };
}

// ---- suspend / resume / void ----

export type TransitionDecision =
  | { ok: true; changed: boolean }
  | { ok: false; reason: Rejection };

/** Suspending a suspended card is a no-op that succeeds. */
export function decideSuspend(card: CardSnapshot): TransitionDecision {
  const status = effectiveStatus(card);
  if (status === "suspended") return { ok: true, changed: false };
  if (status === "active") return { ok: true, changed: true };
  return { ok: false, reason: rejectionFor(status) };
}

/** Resuming an active card is a no-op that succeeds. */
export function decideResume(card: CardSnapshot): TransitionDecision {
  const status = effectiveStatus(card);
  if (status === "active") return { ok: true, changed: false };
  if (status === "suspended") return { ok: true, changed: true };
  return { ok: false, reason: rejectionFor(status) };
}

export type VoidDecision = { changed: boolean; voidedAmount: number };

/** Void is allowed from every status; on an already voided card it is a no-op. */
export function decideVoid(card: Pick<CardSnapshot, "status" | "balance">): VoidDecision {
  if (card.status === "voided") return { changed: false, voidedAmount: 0 };
  return { changed: true, voidedAmount: card.balance };
}

// ---- PIN ----

export interface PinAttemptInput {
  hasPin: boolean;
  providedPin: string | null | undefined;
  storedPin: string | null;
  failedAttempts: number;
  locked: boolean;
}

export type PinAttemptDecision =
  // Locked: the generic failure, even for the correct PIN; nothing is written
  | { outcome: "locked" }
  // PIN card, no PIN given: the generic failure; does not count as an attempt, nothing is written
  | { outcome: "missing_pin" }
  // Wrong PIN: write `failedAttempts`; when `lock` is true, also start the lockout (the counter resets to 0)
  | { outcome: "wrong_pin"; failedAttempts: number; lock: boolean }
  // Authenticated: reset the counter when `resetAttempts` is true
  | { outcome: "ok"; resetAttempts: boolean };

function pinsMatch(provided: string, stored: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(stored, "utf8");
  // timingSafeEqual requires equal lengths; a length mismatch is simply wrong
  return a.length === b.length && timingSafeEqual(a, b);
}

export function decidePinAttempt(input: PinAttemptInput): PinAttemptDecision {
  if (input.locked) return { outcome: "locked" };
  const resetAttempts = input.failedAttempts > 0;
  if (!input.hasPin) return { outcome: "ok", resetAttempts };
  if (input.storedPin === null) throw new Error("A card with a PIN has no stored PIN");
  if (input.providedPin === null || input.providedPin === undefined) return { outcome: "missing_pin" };
  if (pinsMatch(input.providedPin, input.storedPin)) return { outcome: "ok", resetAttempts };
  const attempts = input.failedAttempts + 1;
  return attempts >= PIN_MAX_FAILED_ATTEMPTS
    ? { outcome: "wrong_pin", failedAttempts: 0, lock: true }
    : { outcome: "wrong_pin", failedAttempts: attempts, lock: false };
}
