import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IMMUTABLE_AFTER_ISSUE,
  ProgramDefinitionInput,
  ProgramState,
  validateProgramDefinition,
  validateProgramUpdate,
} from "../../src/gift-cards/program-rules";

const paid: ProgramDefinitionInput = {
  name: "Store credit",
  cardType: "paid",
  currency: "CAD",
  country: "CA",
  cardNumberPrefix: "7000",
  cardNumberLength: 19,
  pinRequired: false,
  maxValue: 50000,
};
const promo: ProgramDefinitionInput = { ...paid, cardType: "promotional", expiryMonths: 12 };

function problemsOf(input: ProgramDefinitionInput): string {
  const result = validateProgramDefinition(input);
  assert.equal(result.ok, false);
  return result.ok ? "" : result.problems.join("\n");
}

test("a valid definition normalizes absent optionals to null", () => {
  const result = validateProgramDefinition(paid);
  assert.ok(result.ok);
  assert.deepEqual(result.ok && result.value, {
    ...paid,
    region: null,
    expiryMonths: null,
    staffDailyIssueLimit: null,
  });
  assert.ok(validateProgramDefinition({ ...paid, staffDailyIssueLimit: 10000, region: "CA-ON" }).ok);
  assert.ok(validateProgramDefinition(promo).ok);
});

test("country must be supported", () => {
  assert.match(problemsOf({ ...paid, country: "US" }), /country is not supported/);
  assert.match(problemsOf({ ...paid, country: "ca" }), /country is not supported/);
  assert.ok(validateProgramDefinition({ ...paid, currency: "KWD", country: "KW" }).ok);
});

test("currency must be supported", () => {
  assert.match(problemsOf({ ...paid, currency: "EUR" }), /currency is not supported/);
});

test("region must match country", () => {
  assert.match(problemsOf({ ...paid, region: "AE-AZ" }), /region/);
  assert.ok(validateProgramDefinition({ ...paid, region: "CA-ON" }).ok);
});

test("region format", () => {
  for (const region of ["CA", "CA-", "CA-ONTA", "ca-on", "CA_ON", "CA-O N"]) {
    assert.match(problemsOf({ ...paid, region }), /region/, region);
  }
  assert.ok(validateProgramDefinition({ ...paid, region: "CA-B1" }).ok);
});

test("expiry only for promotional", () => {
  assert.ok(validateProgramDefinition({ ...promo, expiryMonths: 1 }).ok);
  assert.ok(validateProgramDefinition({ ...promo, expiryMonths: 120 }).ok);
  assert.ok(validateProgramDefinition({ ...promo, expiryMonths: null }).ok);
  assert.match(problemsOf({ ...promo, expiryMonths: 0 }), /expiryMonths/);
  assert.match(problemsOf({ ...promo, expiryMonths: 121 }), /expiryMonths/);
  assert.match(problemsOf({ ...promo, expiryMonths: 1.5 }), /expiryMonths/);
});

test("paid with expiry rejected", () => {
  assert.match(problemsOf({ ...paid, expiryMonths: 12 }), /expiryMonths is allowed only on promotional/);
});

test("staff limit only for paid", () => {
  assert.ok(validateProgramDefinition({ ...paid, staffDailyIssueLimit: 1 }).ok);
  assert.match(problemsOf({ ...promo, staffDailyIssueLimit: 100 }), /staffDailyIssueLimit is allowed only on paid/);
  assert.match(problemsOf({ ...paid, staffDailyIssueLimit: 0 }), /staffDailyIssueLimit/);
  assert.match(problemsOf({ ...paid, staffDailyIssueLimit: 2_000_000_001 }), /staffDailyIssueLimit/);
});

test("max value bounds", () => {
  assert.ok(validateProgramDefinition({ ...paid, maxValue: 1 }).ok);
  assert.ok(validateProgramDefinition({ ...paid, maxValue: 2_000_000_000 }).ok);
  for (const maxValue of [0, -1, 2_000_000_001, 1.5]) {
    assert.match(problemsOf({ ...paid, maxValue }), /maxValue/, String(maxValue));
  }
});

test("numbering problems are reported, including the pinless 19-digit rule", () => {
  assert.match(problemsOf({ ...paid, cardNumberPrefix: "8100" }), /payment network/);
  assert.match(problemsOf({ ...paid, cardNumberLength: 16 }), /19/);
  assert.ok(validateProgramDefinition({ ...paid, cardNumberLength: 16, pinRequired: true }).ok);
});

test("all problems are reported together", () => {
  const problems = problemsOf({ ...paid, country: "US", currency: "EUR", maxValue: 0 });
  for (const part of [/country/, /currency/, /maxValue/]) assert.match(problems, part);
});

const current: ProgramState = {
  name: "Store credit",
  cardType: "paid",
  currency: "CAD",
  country: "CA",
  region: null,
  cardNumberPrefix: "7000",
  cardNumberLength: 19,
  pinRequired: false,
  maxValue: 50000,
  expiryMonths: null,
  staffDailyIssueLimit: null,
  status: "active",
};

test("immutable field list", () => {
  assert.deepEqual([...IMMUTABLE_AFTER_ISSUE].sort(), [
    "cardNumberLength",
    "cardNumberPrefix",
    "cardType",
    "country",
    "currency",
    "region",
  ]);
});

test("update: immutable fields are editable before the first card and rejected after", () => {
  const patches = {
    cardType: { cardType: "promotional" as const },
    currency: { currency: "USD" },
    country: { country: "AE", currency: "AED" }, // country change; currency moves with it
    region: { region: "CA-ON" },
    cardNumberPrefix: { cardNumberPrefix: "7100" },
    cardNumberLength: { cardNumberLength: 18, pinRequired: true },
  };
  for (const [field, patch] of Object.entries(patches)) {
    const before = validateProgramUpdate(current, patch, false);
    assert.ok(before.ok, `${field} editable before issue`);
    const after = validateProgramUpdate(current, patch, true);
    assert.equal(after.ok, false, `${field} frozen after issue`);
    assert.ok(!after.ok && after.immutableFields.includes(field), field);
  }
});

test("update: mutable fields change after the first card, with from/to recorded", () => {
  const result = validateProgramUpdate(
    current,
    { name: "New", maxValue: 10, staffDailyIssueLimit: 500, status: "retired" },
    true
  );
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.maxValue, 10);
  assert.equal(result.value.status, "retired");
  assert.deepEqual(
    result.changes.find((c) => c.field === "staffDailyIssueLimit"),
    { field: "staffDailyIssueLimit", from: null, to: 500 }
  );
  assert.equal(result.changes.length, 4);
});

test("update: a patch equal to the current value is not a change, even for an immutable field", () => {
  const same = validateProgramUpdate(current, { country: "CA", maxValue: 1 }, true);
  assert.ok(same.ok);
  assert.deepEqual(same.ok && same.changes.map((c) => c.field), ["maxValue"]);
});

test("update: empty or no-op patch is a problem, not a 409", () => {
  for (const patch of [{}, { name: current.name }]) {
    const result = validateProgramUpdate(current, patch, false);
    assert.ok(!result.ok && result.immutableFields.length === 0 && result.problems.length > 0);
  }
});

test("update: the merged program is re-validated", () => {
  const noPin = validateProgramUpdate({ ...current, pinRequired: true, cardNumberLength: 16 }, { pinRequired: false }, true);
  assert.ok(!noPin.ok && /19/.test(noPin.problems.join()) && noPin.immutableFields.length === 0);
  const paidWithExpiry = validateProgramUpdate(current, { expiryMonths: 6 }, true);
  assert.ok(!paidWithExpiry.ok && /expiryMonths/.test(paidWithExpiry.problems.join()));
  const ok = validateProgramUpdate({ ...current, cardType: "promotional" }, { expiryMonths: 6 }, true);
  assert.ok(ok.ok);
  const badStatus = validateProgramUpdate(current, { status: "gone" as "retired" }, false);
  assert.ok(!badStatus.ok);
});
