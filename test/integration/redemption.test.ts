import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { buildApp } from "../../src/app";
import { generateCardNumber } from "../../src/gift-cards/card-number";
import {
  adminQuery,
  createGiftCardProgram,
  getAppDataSource,
  issueGiftCard,
  loadTestConfig,
  send,
  setupTenantActors,
  useTestApp,
  type TenantActors,
} from "./helpers";

const getApp = useTestApp();

type Headers = { authorization: string };

const CARD_AUTH_FAILED = "Invalid card number or PIN";
const CARD_KEYS = [
  "id",
  "programId",
  "referenceNumber",
  "last4",
  "currency",
  "currencyExponent",
  "initialAmount",
  "balance",
  "status",
  "hasPin",
  "expiresAt",
  "pinLocked",
  "createdAt",
  "updatedAt",
].sort();
const TRANSACTION_KEYS = [
  "id",
  "giftCardId",
  "type",
  "amount",
  "currency",
  "balanceAfter",
  "relatedTransactionId",
  "externalReference",
  "actorUserId",
  "createdAt",
].sort();

interface CardDto {
  id: string;
  balance: number;
  status: string;
  hasPin: boolean;
  pinLocked: boolean;
}

interface TransactionDto {
  id: string;
  giftCardId: string;
  type: string;
  amount: number;
  balanceAfter: number;
  relatedTransactionId: string | null;
  externalReference: string | null;
  actorUserId: string;
}

interface TransactionResult {
  transaction: TransactionDto;
  card: CardDto;
}

interface Fixture {
  actors: TenantActors;
  programId: string;
  card: { id: string; number: string; pin: string | null };
}

const newKey = () => randomBytes(12).toString("hex");

/** A tenant with a PIN-required program and one card of `amount`. */
async function fixture(amount = 10000, programOverrides: Record<string, unknown> = {}): Promise<Fixture> {
  const actors = await setupTenantActors(getApp(), "acme", "ada@acme.example");
  const programId = await createGiftCardProgram(getApp(), actors.admin, programOverrides);
  const card = await issueGiftCard(getApp(), actors.admin, actors.signup.tenantId, programId, amount);
  return { actors, programId, card };
}

/** The wrong PIN for a card (never equal to its real one). */
const wrongPin = (pin: string | null) => (pin === "123456" ? "654321" : "123456");

function lookup(headers: Headers, payload: Record<string, unknown>) {
  return send(getApp(), { method: "POST", url: "/gift-cards/lookup", headers, payload });
}

function redeem(headers: Headers, payload: Record<string, unknown>) {
  return send(getApp(), { method: "POST", url: "/gift-cards/redeem", headers, payload });
}

function redeemBody(card: { number: string; pin: string | null }, amount: number, overrides: Record<string, unknown> = {}) {
  return {
    cardNumber: card.number,
    ...(card.pin === null ? {} : { pin: card.pin }),
    amount,
    idempotencyKey: newKey(),
    ...overrides,
  };
}

function refund(headers: Headers, transactionId: string, payload: Record<string, unknown>) {
  return send(getApp(), { method: "POST", url: `/gift-card-transactions/${transactionId}/refunds`, headers, payload });
}

async function redeemOk(headers: Headers, card: { number: string; pin: string | null }, amount: number) {
  const res = await redeem(headers, redeemBody(card, amount));
  assert.equal(res.statusCode, 201, res.body);
  return res.json<TransactionResult>();
}

function replayed(res: LightMyRequestResponse): boolean {
  return res.headers["idempotent-replayed"] === "true";
}

async function ledger(cardId: string): Promise<{ type: string; amount: number; balance_after: number }[]> {
  return (await adminQuery(
    `SELECT type, amount, balance_after FROM gift_card_transactions WHERE gift_card_id = $1 ORDER BY created_at, id`,
    [cardId]
  )) as { type: string; amount: number; balance_after: number }[];
}

async function cardRow(cardId: string) {
  const [row] = (await adminQuery(
    `SELECT balance, status, failed_pin_attempts, pin_locked_until FROM gift_cards WHERE id = $1`,
    [cardId]
  )) as { balance: number; status: string; failed_pin_attempts: number; pin_locked_until: Date | null }[];
  return row;
}

async function auditRows(action: string): Promise<{ user_id: string; details: unknown }[]> {
  return (await adminQuery(`SELECT user_id, details FROM audit_logs WHERE action = $1`, [action])) as {
    user_id: string;
    details: unknown;
  }[];
}

function assertAuthFailed(res: LightMyRequestResponse) {
  assert.equal(res.statusCode, 404, res.body);
  assert.deepEqual(res.json(), { error: CARD_AUTH_FAILED });
}

// The ledger is the source of truth for every balance
afterEach(async () => {
  const [row] = (await adminQuery(
    `SELECT count(*)::int AS bad FROM gift_cards c
      WHERE c.balance <> COALESCE((SELECT SUM(CASE WHEN t.type IN ('issue', 'refund') THEN t.amount ELSE -t.amount END)
                                     FROM gift_card_transactions t WHERE t.gift_card_id = c.id), 0)`
  )) as { bad: number }[];
  assert.equal(row.bad, 0, "every card balance equals the sum of its ledger rows");
});

// ---------- lookup and authentication ----------

test("lookup with the correct number and PIN returns the card, whatever the number's formatting", async () => {
  const f = await fixture();
  const spaced = f.card.number.replace(/(.{4})/g, "$1 ").trim();
  const hyphenated = f.card.number.replace(/(.{4})/g, "$1-").replace(/-$/, "");
  for (const cardNumber of [f.card.number, spaced, hyphenated]) {
    const res = await lookup(f.actors.staff, { cardNumber, pin: f.card.pin });
    assert.equal(res.statusCode, 200, res.body);
    const { card } = res.json<{ card: CardDto }>();
    assert.deepEqual(Object.keys(card).sort(), CARD_KEYS);
    assert.equal(card.id, f.card.id);
    assert.equal(card.balance, 10000);
    assert.equal(card.status, "active");
    assert.ok(!res.body.includes(f.card.number) && !res.body.includes(f.card.pin ?? "x"));
  }
});

test("wrong number, wrong PIN, missing PIN and a locked card give byte-identical 404s", async () => {
  const f = await fixture();
  const other = await issueGiftCard(getApp(), f.actors.admin, f.actors.signup.tenantId, f.programId, 100);
  const badLuhn = f.card.number.slice(0, -1) + ((Number(f.card.number.slice(-1)) + 1) % 10);

  const responses: LightMyRequestResponse[] = [];
  // Not normalizable (Luhn), well-formed but unknown, wrong PIN, missing PIN
  responses.push(await redeem(f.actors.staff, { ...redeemBody(f.card, 100), cardNumber: badLuhn }));
  responses.push(await redeem(f.actors.staff, { ...redeemBody(f.card, 100), cardNumber: generateCardNumber("7000", 16) }));
  responses.push(await redeem(f.actors.staff, { ...redeemBody(f.card, 100), pin: wrongPin(f.card.pin) }));
  responses.push(await redeem(f.actors.staff, { ...redeemBody(f.card, 100), pin: undefined }));
  // Lock the other card, then use its correct PIN
  for (let i = 0; i < 5; i++) {
    await lookup(f.actors.staff, { cardNumber: other.number, pin: wrongPin(other.pin) });
  }
  responses.push(await redeem(f.actors.staff, redeemBody(other, 100)));

  for (const res of responses) assertAuthFailed(res);
  assert.equal(new Set(responses.map((r) => r.body)).size, 1, "one body for every cause");
  assert.equal(new Set(responses.map((r) => r.headers["content-length"])).size, 1);
  // Same for lookup
  assertAuthFailed(await lookup(f.actors.staff, { cardNumber: other.number, pin: other.pin }));
  assertAuthFailed(await lookup(f.actors.staff, { cardNumber: f.card.number }));
  assert.equal((await ledger(f.card.id)).length, 1, "nothing was redeemed");
});

test("the idempotency oracle is closed: a used key never changes the answer for an unauthenticated caller", async () => {
  const f = await fixture();
  const body = redeemBody(f.card, 100);
  assert.equal((await redeem(f.actors.staff, body)).statusCode, 201);

  // The key is in use. Without the right PIN the answer is still the generic 404, never 200 or 409
  assertAuthFailed(await redeem(f.actors.staff, { ...body, pin: wrongPin(f.card.pin) }));
  assertAuthFailed(await redeem(f.actors.staff, { ...body, pin: undefined }));
  assertAuthFailed(await redeem(f.actors.staff, { ...body, cardNumber: generateCardNumber("7000", 16) }));
  // Locked (the wrong attempt above plus four more)
  for (let i = 0; i < 4; i++) assertAuthFailed(await redeem(f.actors.staff, { ...body, pin: wrongPin(f.card.pin) }));
  assertAuthFailed(await redeem(f.actors.staff, body));
  assert.equal((await ledger(f.card.id)).length, 2);
});

test("a PIN-less card redeems with the number only", async () => {
  const actors = await setupTenantActors(getApp(), "acme", "ada@acme.example");
  const programId = await createGiftCardProgram(getApp(), actors.admin, {
    name: "No PIN",
    pinRequired: false,
    cardNumberLength: 19,
  });
  const card = await issueGiftCard(getApp(), actors.admin, actors.signup.tenantId, programId, 500);
  assert.equal(card.pin, null);

  const looked = await lookup(actors.staff, { cardNumber: card.number });
  assert.equal(looked.statusCode, 200, looked.body);
  assert.equal(looked.json<{ card: CardDto }>().card.hasPin, false);
  const res = await redeem(actors.staff, { cardNumber: card.number, amount: 200, idempotencyKey: newKey() });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json<TransactionResult>().card.balance, 300);
  // A PIN supplied for a PIN-less card is ignored
  const withPin = await redeem(actors.staff, {
    cardNumber: card.number,
    pin: "123456",
    amount: 100,
    idempotencyKey: newKey(),
  });
  assert.equal(withPin.statusCode, 201, withPin.body);
});

test("5 wrong PINs lock the card (audited with the actor); the correct PIN fails until an admin unlocks", async () => {
  const f = await fixture();
  for (let i = 1; i <= 4; i++) {
    assertAuthFailed(await redeem(f.actors.staff, { ...redeemBody(f.card, 100), pin: wrongPin(f.card.pin) }));
    assert.equal((await cardRow(f.card.id)).failed_pin_attempts, i);
  }
  assert.deepEqual(await auditRows("gift_card.pin_locked"), []);

  assertAuthFailed(await redeem(f.actors.staff, { ...redeemBody(f.card, 100), pin: wrongPin(f.card.pin) }));
  const locked = await cardRow(f.card.id);
  assert.equal(locked.failed_pin_attempts, 0, "the counter resets when the lock starts");
  assert.ok(locked.pin_locked_until && locked.pin_locked_until.getTime() > Date.now() + 29 * 60_000);
  const audit = await auditRows("gift_card.pin_locked");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].user_id, f.actors.staffId);
  assert.deepEqual(audit[0].details, { giftCardId: f.card.id });

  assertAuthFailed(await redeem(f.actors.staff, redeemBody(f.card, 100)));
  assertAuthFailed(await lookup(f.actors.staff, { cardNumber: f.card.number, pin: f.card.pin }));
  const asRead = await send(getApp(), { method: "GET", url: `/gift-cards/${f.card.id}`, headers: f.actors.staff });
  assert.equal(asRead.json<{ card: CardDto }>().card.pinLocked, true);

  const unlocked = await send(getApp(), {
    method: "POST",
    url: `/gift-cards/${f.card.id}/unlock`,
    headers: f.actors.admin,
  });
  assert.equal(unlocked.statusCode, 200, unlocked.body);
  const res = await redeem(f.actors.staff, redeemBody(f.card, 100));
  assert.equal(res.statusCode, 201, res.body);
});

test("the lock expires after 30 minutes", async () => {
  const f = await fixture();
  for (let i = 0; i < 5; i++) {
    await redeem(f.actors.staff, { ...redeemBody(f.card, 100), pin: wrongPin(f.card.pin) });
  }
  assertAuthFailed(await redeem(f.actors.staff, redeemBody(f.card, 100)));

  await adminQuery(`UPDATE gift_cards SET pin_locked_until = now() - interval '1 second' WHERE id = $1`, [f.card.id]);
  const res = await redeem(f.actors.staff, redeemBody(f.card, 100));
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json<TransactionResult>().card.pinLocked, false);
});

test("a correct PIN resets the failed-attempt counter; a missing PIN does not count", async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) await lookup(f.actors.staff, { cardNumber: f.card.number, pin: wrongPin(f.card.pin) });
  assert.equal((await cardRow(f.card.id)).failed_pin_attempts, 3);
  assertAuthFailed(await lookup(f.actors.staff, { cardNumber: f.card.number }));
  assert.equal((await cardRow(f.card.id)).failed_pin_attempts, 3, "a missing PIN is not an attempt");

  const ok = await lookup(f.actors.staff, { cardNumber: f.card.number, pin: f.card.pin });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal((await cardRow(f.card.id)).failed_pin_attempts, 0);
});

test("a failed authentication logs a warn line with the user and no card number", async () => {
  const lines: string[] = [];
  const app = await buildApp({
    config: loadTestConfig(),
    dataSource: getAppDataSource(),
    logger: { level: "warn", stream: { write: (line: string) => void lines.push(line) } },
  });
  try {
    const actors = await setupTenantActors(app, "acme", "ada@acme.example");
    const programId = await createGiftCardProgram(app, actors.admin);
    const card = await issueGiftCard(app, actors.admin, actors.signup.tenantId, programId, 1000);
    lines.length = 0;

    const res = await send(app, {
      method: "POST",
      url: "/gift-cards/redeem",
      headers: actors.staff,
      payload: { ...redeemBody(card, 100), pin: wrongPin(card.pin) },
    });
    assertAuthFailed(res);

    const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const failures = entries.filter((e) => e.outcome === "card_auth_failed");
    assert.equal(failures.length, 1);
    const { level, userId, tenantId, route, outcome, req, res: logRes, ...rest } = failures[0];
    assert.equal(level, 40);
    assert.equal(userId, actors.staffId);
    assert.equal(tenantId, actors.signup.tenantId);
    assert.equal(route, "/gift-cards/redeem");
    assert.equal(outcome, "card_auth_failed");
    assert.equal(req, undefined);
    assert.equal(logRes, undefined);
    assert.deepEqual(Object.keys(rest).sort(), ["hostname", "pid", "reqId", "time"]);
    assert.ok(!lines.join("").includes(card.number), "the card number is in no log line");
  } finally {
    await app.close();
  }
});

test("lookup and redeem each allow 30 requests a minute per user, without limiting other routes", async () => {
  const f = await fixture();
  for (let i = 0; i < 30; i++) {
    const res = await lookup(f.actors.staff, { cardNumber: f.card.number, pin: f.card.pin });
    assert.equal(res.statusCode, 200, `request ${i + 1}`);
  }
  const limited = await lookup(f.actors.staff, { cardNumber: f.card.number, pin: f.card.pin });
  assert.equal(limited.statusCode, 429, limited.body);
  // Another user, another route and the redeem route have their own counters
  assert.equal((await lookup(f.actors.admin, { cardNumber: f.card.number, pin: f.card.pin })).statusCode, 200);
  assert.equal((await redeem(f.actors.staff, redeemBody(f.card, 100))).statusCode, 201);
  const read = await send(getApp(), { method: "GET", url: `/gift-cards/${f.card.id}`, headers: f.actors.staff });
  assert.equal(read.statusCode, 200, read.body);
});

test("bodies are validated: shape, PIN format, unknown fields, amounts", async () => {
  const f = await fixture();
  const good = redeemBody(f.card, 100);
  for (const bad of [
    { ...good, pin: "12345" },
    { ...good, pin: "12345a" },
    { ...good, cardNumber: "abc" },
    { ...good, amount: 0 },
    { ...good, amount: 1.5 },
    { ...good, amount: "100" },
    { ...good, idempotencyKey: "short" },
    { ...good, externalReference: "" },
    { ...good, externalReference: "x".repeat(65) },
    { ...good, extra: 1 },
    { cardNumber: f.card.number, amount: 100 },
  ]) {
    const res = await redeem(f.actors.staff, bad);
    assert.equal(res.statusCode, 400, `${JSON.stringify(bad)} -> ${res.body}`);
  }
  assert.equal((await lookup(f.actors.staff, { cardNumber: f.card.number, extra: 1 })).statusCode, 400);
  assert.equal((await ledger(f.card.id)).length, 1);
});

// ---------- redeem ----------

test("redeem partial: 201, the ledger row, the new balance, the external reference", async () => {
  const f = await fixture();
  const res = await redeem(f.actors.staff, redeemBody(f.card, 2500, { externalReference: "POS-42" }));
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(replayed(res), false);
  const { transaction, card } = res.json<TransactionResult>();
  assert.deepEqual(Object.keys(transaction).sort(), TRANSACTION_KEYS);
  assert.deepEqual(Object.keys(card).sort(), CARD_KEYS);
  assert.equal(transaction.type, "redeem");
  assert.equal(transaction.amount, 2500);
  assert.equal(transaction.balanceAfter, 7500);
  assert.equal(transaction.externalReference, "POS-42");
  assert.equal(transaction.actorUserId, f.actors.staffId);
  assert.equal(transaction.giftCardId, f.card.id);
  assert.equal(card.balance, 7500);
  assert.equal(card.status, "active");
  assert.deepEqual(await ledger(f.card.id), [
    { type: "issue", amount: 10000, balance_after: 10000 },
    { type: "redeem", amount: 2500, balance_after: 7500 },
  ]);
});

test("redeeming the whole balance depletes the card", async () => {
  const f = await fixture(1000);
  const { card } = await redeemOk(f.actors.staff, f.card, 1000);
  assert.equal(card.balance, 0);
  assert.equal(card.status, "depleted");
  assert.equal((await cardRow(f.card.id)).status, "depleted");
  // A depleted card cannot be redeemed again
  const again = await redeem(f.actors.staff, redeemBody(f.card, 1));
  assert.equal(again.statusCode, 409, again.body);
  assert.deepEqual(again.json(), { error: "Card is not active" });
});

test("insufficient balance -> 409 and no ledger row", async () => {
  const f = await fixture(1000);
  const res = await redeem(f.actors.staff, redeemBody(f.card, 1001));
  assert.equal(res.statusCode, 409, res.body);
  assert.deepEqual(res.json(), { error: "Insufficient balance" });
  assert.equal((await ledger(f.card.id)).length, 1);
  assert.equal((await cardRow(f.card.id)).balance, 1000);
});

test("an expired card -> 409, stored as expired, balance unchanged", async () => {
  const f = await fixture(1000);
  await adminQuery(`UPDATE gift_cards SET expires_at = now() - interval '1 day' WHERE id = $1`, [f.card.id]);

  const looked = await lookup(f.actors.staff, { cardNumber: f.card.number, pin: f.card.pin });
  assert.equal(looked.json<{ card: CardDto }>().card.status, "expired");
  assert.equal((await cardRow(f.card.id)).status, "active", "lookup never writes the status");

  const res = await redeem(f.actors.staff, redeemBody(f.card, 100));
  assert.equal(res.statusCode, 409, res.body);
  assert.deepEqual(res.json(), { error: "Card has expired" });
  const row = await cardRow(f.card.id);
  assert.equal(row.status, "expired");
  assert.equal(row.balance, 1000);
  assert.equal((await ledger(f.card.id)).length, 1);
});

test("a suspended card -> 409; resumed, it redeems", async () => {
  const f = await fixture();
  const suspend = await send(getApp(), {
    method: "POST",
    url: `/gift-cards/${f.card.id}/suspend`,
    headers: f.actors.admin,
  });
  assert.equal(suspend.statusCode, 200, suspend.body);
  const res = await redeem(f.actors.staff, redeemBody(f.card, 100));
  assert.equal(res.statusCode, 409, res.body);
  assert.deepEqual(res.json(), { error: "Card is not active" });
  await send(getApp(), { method: "POST", url: `/gift-cards/${f.card.id}/resume`, headers: f.actors.admin });
  assert.equal((await redeem(f.actors.staff, redeemBody(f.card, 100))).statusCode, 201);
});

test("a voided card cannot be redeemed", async () => {
  const f = await fixture();
  await send(getApp(), { method: "POST", url: `/gift-cards/${f.card.id}/void`, headers: f.actors.admin });
  const res = await redeem(f.actors.staff, redeemBody(f.card, 100));
  assert.equal(res.statusCode, 409, res.body);
});

test("replay returns the same transaction with the header and writes nothing", async () => {
  const f = await fixture();
  const body = redeemBody(f.card, 400);
  const first = await redeem(f.actors.staff, body);
  assert.equal(first.statusCode, 201, first.body);
  const second = await redeem(f.actors.staff, body);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(replayed(second), true);
  assert.equal(second.json<TransactionResult>().transaction.id, first.json<TransactionResult>().transaction.id);
  assert.deepEqual(second.json<TransactionResult>().transaction, first.json<TransactionResult>().transaction);
  assert.equal((await ledger(f.card.id)).length, 2);
  assert.equal((await cardRow(f.card.id)).balance, 9600);

  // The replay is of the request, so it survives later changes to the card
  await send(getApp(), { method: "POST", url: `/gift-cards/${f.card.id}/suspend`, headers: f.actors.admin });
  const third = await redeem(f.actors.staff, body);
  assert.equal(third.statusCode, 200, third.body);
});

test("a key reused with a different amount, reference or card -> 409", async () => {
  const f = await fixture();
  const other = await issueGiftCard(getApp(), f.actors.admin, f.actors.signup.tenantId, f.programId, 5000);
  const body = redeemBody(f.card, 400);
  assert.equal((await redeem(f.actors.staff, body)).statusCode, 201);
  const conflict = { error: "Idempotency key already used with a different request" };
  for (const changed of [
    { ...body, amount: 401 },
    { ...body, externalReference: "other" },
    redeemBody(other, 400, { idempotencyKey: body.idempotencyKey }),
  ]) {
    const res = await redeem(f.actors.staff, changed);
    assert.equal(res.statusCode, 409, res.body);
    assert.deepEqual(res.json(), conflict);
  }
  assert.equal((await cardRow(other.id)).balance, 5000);
  assert.equal((await ledger(f.card.id)).length, 2);
});

test("a key already used by an issue cannot be reused to redeem", async () => {
  const f = await fixture();
  const [{ idempotency_key }] = (await adminQuery(
    `SELECT idempotency_key FROM gift_card_transactions WHERE gift_card_id = $1`,
    [f.card.id]
  )) as { idempotency_key: string }[];
  const res = await redeem(f.actors.staff, redeemBody(f.card, 100, { idempotencyKey: idempotency_key }));
  assert.equal(res.statusCode, 409, res.body);
});

test("another tenant's card number is the generic 404 and leaves the card untouched", async () => {
  const f = await fixture();
  const b = await setupTenantActors(getApp(), "beta", "bob@beta.example");
  assertAuthFailed(await redeem(b.staff, redeemBody(f.card, 100)));
  assertAuthFailed(await lookup(b.staff, { cardNumber: f.card.number, pin: f.card.pin }));
  assert.equal((await cardRow(f.card.id)).failed_pin_attempts, 0);
});

// ---------- refunds ----------

test("refund up to the redeemed amount, in parts", async () => {
  const f = await fixture();
  const redeemed = await redeemOk(f.actors.staff, f.card, 3000);
  const url = redeemed.transaction.id;

  const part = await refund(f.actors.admin, url, { amount: 1000, idempotencyKey: newKey() });
  assert.equal(part.statusCode, 201, part.body);
  assert.equal(replayed(part), false);
  const { transaction, card } = part.json<TransactionResult>();
  assert.deepEqual(Object.keys(transaction).sort(), TRANSACTION_KEYS);
  assert.equal(transaction.type, "refund");
  assert.equal(transaction.amount, 1000);
  assert.equal(transaction.relatedTransactionId, url);
  assert.equal(transaction.actorUserId, f.actors.signup.adminId);
  assert.equal(transaction.balanceAfter, 8000);
  assert.equal(card.balance, 8000);

  const rest = await refund(f.actors.admin, url, { amount: 2000, idempotencyKey: newKey() });
  assert.equal(rest.statusCode, 201, rest.body);
  assert.equal(rest.json<TransactionResult>().card.balance, 10000);
  assert.deepEqual(
    (await ledger(f.card.id)).map((r) => [r.type, r.amount, r.balance_after]),
    [
      ["issue", 10000, 10000],
      ["redeem", 3000, 7000],
      ["refund", 1000, 8000],
      ["refund", 2000, 10000],
    ]
  );
});

test("a refund over what is still refundable -> 409 and nothing is written", async () => {
  const f = await fixture();
  const { transaction } = await redeemOk(f.actors.staff, f.card, 3000);
  const tooMuch = await refund(f.actors.admin, transaction.id, { amount: 3001, idempotencyKey: newKey() });
  assert.equal(tooMuch.statusCode, 409, tooMuch.body);
  assert.deepEqual(tooMuch.json(), { error: "Refund exceeds the refundable amount" });

  assert.equal((await refund(f.actors.admin, transaction.id, { amount: 2000, idempotencyKey: newKey() })).statusCode, 201);
  const over = await refund(f.actors.admin, transaction.id, { amount: 1001, idempotencyKey: newKey() });
  assert.equal(over.statusCode, 409, over.body);
  assert.equal((await refund(f.actors.admin, transaction.id, { amount: 1000, idempotencyKey: newKey() })).statusCode, 201);
  const none = await refund(f.actors.admin, transaction.id, { amount: 1, idempotencyKey: newKey() });
  assert.equal(none.statusCode, 409, none.body);
  assert.equal((await cardRow(f.card.id)).balance, 10000);
});

test("only a redemption can be refunded; unknown and other tenants' transactions are 404", async () => {
  const f = await fixture();
  const [issueRow] = (await adminQuery(`SELECT id FROM gift_card_transactions WHERE gift_card_id = $1`, [
    f.card.id,
  ])) as { id: string }[];
  const issueRefund = await refund(f.actors.admin, issueRow.id, { amount: 1, idempotencyKey: newKey() });
  assert.equal(issueRefund.statusCode, 409, issueRefund.body);
  assert.deepEqual(issueRefund.json(), { error: "Only a redemption can be refunded" });

  const { transaction } = await redeemOk(f.actors.staff, f.card, 100);
  const refundRow = (await refund(f.actors.admin, transaction.id, { amount: 10, idempotencyKey: newKey() })).json<TransactionResult>();
  const refundOfRefund = await refund(f.actors.admin, refundRow.transaction.id, { amount: 1, idempotencyKey: newKey() });
  assert.equal(refundOfRefund.statusCode, 409, refundOfRefund.body);

  const unknown = await refund(f.actors.admin, "0198a7a0-0000-7000-8000-000000000000", {
    amount: 1,
    idempotencyKey: newKey(),
  });
  assert.equal(unknown.statusCode, 404, unknown.body);
  const b = await setupTenantActors(getApp(), "beta", "bob@beta.example");
  const foreign = await refund(b.admin, transaction.id, { amount: 1, idempotencyKey: newKey() });
  assert.equal(foreign.statusCode, 404, foreign.body);
  assert.equal((await ledger(f.card.id)).length, 3);
});

test("a refund revives a depleted card", async () => {
  const f = await fixture(1000);
  const { transaction, card } = await redeemOk(f.actors.staff, f.card, 1000);
  assert.equal(card.status, "depleted");
  const res = await refund(f.actors.admin, transaction.id, { amount: 400, idempotencyKey: newKey() });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json<TransactionResult>().card.status, "active");
  assert.equal(res.json<TransactionResult>().card.balance, 400);
  assert.equal((await redeem(f.actors.staff, redeemBody(f.card, 400))).statusCode, 201);
});

test("a refund retry after the card was suspended is a 200 replay; a new refund is a 409", async () => {
  const f = await fixture();
  const { transaction } = await redeemOk(f.actors.staff, f.card, 1000);
  const body = { amount: 500, idempotencyKey: newKey() };
  const first = await refund(f.actors.admin, transaction.id, body);
  assert.equal(first.statusCode, 201, first.body);
  await send(getApp(), { method: "POST", url: `/gift-cards/${f.card.id}/suspend`, headers: f.actors.admin });

  const retry = await refund(f.actors.admin, transaction.id, body);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(replayed(retry), true);
  assert.equal(retry.json<TransactionResult>().transaction.id, first.json<TransactionResult>().transaction.id);

  const fresh = await refund(f.actors.admin, transaction.id, { amount: 100, idempotencyKey: newKey() });
  assert.equal(fresh.statusCode, 409, fresh.body);
  assert.deepEqual(fresh.json(), { error: "Card is not active" });
});

test("a refund key reused with a different amount or transaction -> 409", async () => {
  const f = await fixture();
  const one = (await redeemOk(f.actors.staff, f.card, 1000)).transaction;
  const two = (await redeemOk(f.actors.staff, f.card, 1000)).transaction;
  const key = newKey();
  assert.equal((await refund(f.actors.admin, one.id, { amount: 100, idempotencyKey: key })).statusCode, 201);
  for (const [id, amount] of [
    [one.id, 101],
    [two.id, 100],
  ] as const) {
    const res = await refund(f.actors.admin, id, { amount, idempotencyKey: key });
    assert.equal(res.statusCode, 409, res.body);
    assert.deepEqual(res.json(), { error: "Idempotency key already used with a different request" });
  }
});

test("staff cannot refund", async () => {
  const f = await fixture();
  const { transaction } = await redeemOk(f.actors.staff, f.card, 1000);
  const res = await refund(f.actors.staff, transaction.id, { amount: 100, idempotencyKey: newKey() });
  assert.equal(res.statusCode, 403, res.body);
  assert.equal((await ledger(f.card.id)).length, 2);
});

test("refund bodies and ids are validated", async () => {
  const f = await fixture();
  const { transaction } = await redeemOk(f.actors.staff, f.card, 1000);
  for (const bad of [
    { amount: 0, idempotencyKey: newKey() },
    { amount: 1.5, idempotencyKey: newKey() },
    { amount: 1 },
    { amount: 1, idempotencyKey: "short" },
    { amount: 1, idempotencyKey: newKey(), extra: true },
  ]) {
    const res = await refund(f.actors.admin, transaction.id, bad);
    assert.equal(res.statusCode, 400, `${JSON.stringify(bad)} -> ${res.body}`);
  }
  const badId = await refund(f.actors.admin, "not-a-uuid", { amount: 1, idempotencyKey: newKey() });
  assert.equal(badId.statusCode, 400, badId.body);
});

test("routes need authentication", async () => {
  for (const [url, payload] of [
    ["/gift-cards/lookup", { cardNumber: "7000 0000 0000 0000" }],
    ["/gift-cards/redeem", { cardNumber: "7000 0000 0000 0000", amount: 1, idempotencyKey: newKey() }],
    ["/gift-card-transactions/0198a7a0-0000-7000-8000-000000000000/refunds", { amount: 1, idempotencyKey: newKey() }],
  ] as const) {
    const res = await send(getApp(), { method: "POST", url, payload });
    assert.equal(res.statusCode, 401, `${url} -> ${res.body}`);
  }
});
