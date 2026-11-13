import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CardSnapshot,
  CardStatus,
  decideIssue,
  decidePinAttempt,
  decideRedeem,
  decideRefund,
  decideResume,
  decideSuspend,
  decideVoid,
  effectiveStatus,
  IssueProgram,
  PinAttemptInput,
} from "../../src/gift-cards/card-state";

const card = (status: CardStatus, balance = 1000, isExpired = false): CardSnapshot => ({ status, balance, isExpired });
const ALL: CardStatus[] = ["active", "suspended", "depleted", "voided", "expired"];

test("effective status: expiry overrides active, suspended and depleted but never voided", () => {
  for (const status of ["active", "suspended", "depleted", "expired"] as const) {
    assert.equal(effectiveStatus(card(status, 1, true)), "expired", status);
  }
  assert.equal(effectiveStatus(card("voided", 0, true)), "voided");
  for (const status of ALL) assert.equal(effectiveStatus(card(status, 1, false)), status);
});

// ---- issue ----

const program: IssueProgram = { status: "active", cardType: "paid", maxValue: 10000, staffDailyIssueLimit: 5000 };

test("decideIssue: admin on an active program", () => {
  assert.deepEqual(decideIssue(program, "admin", 10000), { ok: true, staffLimit: null });
  assert.deepEqual(decideIssue({ ...program, cardType: "promotional", staffDailyIssueLimit: null }, "admin", 1), {
    ok: true,
    staffLimit: null,
  });
});

test("decideIssue: retired program, amount above max", () => {
  assert.deepEqual(decideIssue({ ...program, status: "retired" }, "admin", 1), { ok: false, reason: "program_retired" });
  assert.deepEqual(decideIssue({ ...program, status: "retired" }, "staff", 1), { ok: false, reason: "program_retired" });
  assert.deepEqual(decideIssue(program, "admin", 10001), { ok: false, reason: "amount_above_max" });
});

test("decideIssue: staff", () => {
  assert.deepEqual(decideIssue(program, "staff", 100), { ok: true, staffLimit: 5000 });
  assert.deepEqual(decideIssue({ ...program, cardType: "promotional" }, "staff", 100), {
    ok: false,
    reason: "promotional_requires_admin",
  });
  assert.deepEqual(decideIssue({ ...program, staffDailyIssueLimit: null }, "staff", 100), {
    ok: false,
    reason: "no_staff_limit",
  });
  assert.deepEqual(decideIssue(program, "staff", 10001), { ok: false, reason: "amount_above_max" });
});

// ---- redeem ----

test("redeem: active, new balance > 0 stays active", () => {
  assert.deepEqual(decideRedeem(card("active", 1000), 400), { ok: true, newBalance: 600, newStatus: "active" });
});

test("redeem: active, new balance = 0 becomes depleted", () => {
  assert.deepEqual(decideRedeem(card("active", 1000), 1000), { ok: true, newBalance: 0, newStatus: "depleted" });
});

test("redeem: insufficient balance", () => {
  assert.deepEqual(decideRedeem(card("active", 1000), 1001), { ok: false, reason: "insufficient_balance" });
});

test("redeem: suspended, depleted and voided are not active", () => {
  assert.deepEqual(decideRedeem(card("suspended"), 1), { ok: false, reason: "not_active" });
  assert.deepEqual(decideRedeem(card("depleted", 0), 1), { ok: false, reason: "not_active" });
  assert.deepEqual(decideRedeem(card("voided", 0), 1), { ok: false, reason: "not_active" });
});

test("redeem: expired, stored or effective", () => {
  assert.deepEqual(decideRedeem(card("expired"), 1), { ok: false, reason: "expired" });
  assert.deepEqual(decideRedeem(card("active", 1000, true), 1), { ok: false, reason: "expired" });
  assert.deepEqual(decideRedeem(card("suspended", 1000, true), 1), { ok: false, reason: "expired" });
});

// ---- refund ----

test("refund: active and depleted cards become active", () => {
  assert.deepEqual(decideRefund(card("active", 600), 400), { ok: true, newBalance: 1000, newStatus: "active" });
  assert.deepEqual(decideRefund(card("depleted", 0), 400), { ok: true, newBalance: 400, newStatus: "active" });
});

test("refund: suspended, voided and expired are rejected", () => {
  assert.deepEqual(decideRefund(card("suspended"), 1), { ok: false, reason: "not_active" });
  assert.deepEqual(decideRefund(card("voided", 0), 1), { ok: false, reason: "not_active" });
  assert.deepEqual(decideRefund(card("expired"), 1), { ok: false, reason: "expired" });
  assert.deepEqual(decideRefund(card("depleted", 0, true), 1), { ok: false, reason: "expired" });
});

// ---- suspend / resume / void ----

test("suspend: active -> suspended; suspended is an idempotent success", () => {
  assert.deepEqual(decideSuspend(card("active")), { ok: true, changed: true });
  assert.deepEqual(decideSuspend(card("suspended")), { ok: true, changed: false });
});

test("suspend: depleted, voided and expired are conflicts", () => {
  assert.deepEqual(decideSuspend(card("depleted", 0)), { ok: false, reason: "not_active" });
  assert.deepEqual(decideSuspend(card("voided", 0)), { ok: false, reason: "not_active" });
  assert.deepEqual(decideSuspend(card("expired")), { ok: false, reason: "expired" });
  assert.deepEqual(decideSuspend(card("active", 1, true)), { ok: false, reason: "expired" });
});

test("resume: suspended -> active; active is an idempotent success", () => {
  assert.deepEqual(decideResume(card("suspended")), { ok: true, changed: true });
  assert.deepEqual(decideResume(card("active")), { ok: true, changed: false });
});

test("resume: depleted, voided and expired are conflicts", () => {
  assert.deepEqual(decideResume(card("depleted", 0)), { ok: false, reason: "not_active" });
  assert.deepEqual(decideResume(card("voided", 0)), { ok: false, reason: "not_active" });
  assert.deepEqual(decideResume(card("suspended", 1, true)), { ok: false, reason: "expired" });
});

test("void: allowed from every status, voiding the remaining balance", () => {
  for (const status of ["active", "suspended", "depleted", "expired"] as const) {
    const balance = status === "depleted" ? 0 : 700;
    assert.deepEqual(decideVoid(card(status, balance)), { changed: true, voidedAmount: balance }, status);
  }
});

test("void: a voided card is an idempotent no-op", () => {
  assert.deepEqual(decideVoid(card("voided", 0)), { changed: false, voidedAmount: 0 });
});

test("voided rejects everything except void", () => {
  const voided = card("voided", 0);
  assert.equal(decideRedeem(voided, 1).ok, false);
  assert.equal(decideRefund(voided, 1).ok, false);
  assert.equal(decideSuspend(voided).ok, false);
  assert.equal(decideResume(voided).ok, false);
  assert.equal(decideVoid(voided).changed, false);
});

// ---- PIN ----

const pinCard: PinAttemptInput = {
  hasPin: true,
  providedPin: "123456",
  storedPin: "123456",
  failedAttempts: 0,
  locked: false,
};

test("pin: correct PIN authenticates and resets only a non-zero counter", () => {
  assert.deepEqual(decidePinAttempt(pinCard), { outcome: "ok", resetAttempts: false });
  assert.deepEqual(decidePinAttempt({ ...pinCard, failedAttempts: 3 }), { outcome: "ok", resetAttempts: true });
});

test("pin: wrong PIN counts up; the 5th failure locks and resets the counter", () => {
  for (const [failed, expected] of [
    [0, { failedAttempts: 1, lock: false }],
    [3, { failedAttempts: 4, lock: false }],
    [4, { failedAttempts: 0, lock: true }],
  ] as const) {
    assert.deepEqual(decidePinAttempt({ ...pinCard, providedPin: "000000", failedAttempts: failed }), {
      outcome: "wrong_pin",
      ...expected,
    });
  }
});

test("pin: locked rejects even the correct PIN, without counting", () => {
  assert.deepEqual(decidePinAttempt({ ...pinCard, locked: true }), { outcome: "locked" });
  assert.deepEqual(decidePinAttempt({ ...pinCard, locked: true, providedPin: "000000" }), { outcome: "locked" });
});

test("pin: a missing PIN does not count", () => {
  assert.deepEqual(decidePinAttempt({ ...pinCard, providedPin: undefined, failedAttempts: 4 }), {
    outcome: "missing_pin",
  });
  assert.deepEqual(decidePinAttempt({ ...pinCard, providedPin: null }), { outcome: "missing_pin" });
});

test("pin: a length mismatch counts as wrong, never throws", () => {
  for (const providedPin of ["12345", "1234567", ""]) {
    assert.deepEqual(decidePinAttempt({ ...pinCard, providedPin }), {
      outcome: "wrong_pin",
      failedAttempts: 1,
      lock: false,
    });
  }
});

test("pin: a PIN-less card authenticates without a PIN", () => {
  const pinless: PinAttemptInput = { ...pinCard, hasPin: false, storedPin: null, providedPin: undefined };
  assert.deepEqual(decidePinAttempt(pinless), { outcome: "ok", resetAttempts: false });
  assert.deepEqual(decidePinAttempt({ ...pinless, locked: true }), { outcome: "locked" });
});

test("pin: a card with a PIN but no stored PIN is a bug, not an auth failure", () => {
  assert.throws(() => decidePinAttempt({ ...pinCard, storedPin: null }), /no stored PIN/);
});
