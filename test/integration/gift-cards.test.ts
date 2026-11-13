import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { isLuhnValid } from "../../src/gift-cards/card-number";
import { CardCrypto } from "../../src/gift-cards/card-crypto";
import { requestHashIssue } from "../../src/gift-cards/request-hash";
import {
  PASSWORD,
  UUID_V7,
  adminQuery,
  bearer,
  loadTestConfig,
  login,
  send,
  signupTenant,
  useTestApp,
  type SignupResult,
} from "./helpers";
import { openAdminTransaction, waitUntilBlocked } from "../support/lock-staging";

const getApp = useTestApp();

type Headers = { authorization: string };

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

const DELIVERY_KEYS = [
  "id",
  "recipientName",
  "recipientEmail",
  "senderName",
  "message",
  "sendAt",
  "status",
  "attempts",
  "sentAt",
  "openedAt",
  "revealCount",
  "lastRevealedAt",
].sort();

interface CardDto {
  id: string;
  programId: string;
  referenceNumber: string;
  last4: string;
  currency: string;
  currencyExponent: number;
  initialAmount: number;
  balance: number;
  status: string;
  hasPin: boolean;
  expiresAt: string | null;
  pinLocked: boolean;
}

interface DeliveryDto {
  id: string;
  recipientName: string;
  recipientEmail: string;
  senderName: string;
  message: string | null;
  sendAt: string;
  status: string;
  attempts: number;
  sentAt: string | null;
  openedAt: string | null;
  revealCount: number;
}

interface CardWithDelivery {
  card: CardDto;
  delivery: DeliveryDto;
}

interface TransactionDto {
  id: string;
  giftCardId: string;
  type: string;
  amount: number;
  currency: string;
  balanceAfter: number;
  relatedTransactionId: string | null;
  externalReference: string | null;
  actorUserId: string;
}

interface Actor {
  signup: SignupResult;
  staffId: string;
  admin: Headers;
  staff: Headers;
}

const programBody = {
  name: "Holiday",
  cardType: "paid",
  currency: "CAD",
  country: "CA",
  cardNumberPrefix: "7000",
  cardNumberLength: 16,
  pinRequired: true,
  maxValue: 100000,
};

async function setupTenant(subdomain: string, email: string): Promise<Actor> {
  const signup = await signupTenant(getApp(), subdomain, email);
  const admin = bearer((await login(getApp(), signup.email)).accessToken);
  const staffEmail = `staff@${subdomain}.com`;
  const created = await send(getApp(), {
    method: "POST",
    url: "/users",
    headers: admin,
    payload: { name: "Sam", email: staffEmail, password: PASSWORD },
  });
  assert.equal(created.statusCode, 201, created.body);
  const staff = bearer((await login(getApp(), staffEmail)).accessToken);
  return { signup, staffId: created.json<{ id: string }>().id, admin, staff };
}

async function createProgram(headers: Headers, overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await send(getApp(), {
    method: "POST",
    url: "/gift-card-programs",
    headers,
    payload: { ...programBody, ...overrides },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json<{ id: string }>().id;
}

function patchProgram(headers: Headers, id: string, payload: Record<string, unknown>) {
  return send(getApp(), { method: "PATCH", url: `/gift-card-programs/${id}`, headers, payload });
}

const newKey = () => randomBytes(12).toString("hex");

function issueBody(programId: string, overrides: Record<string, unknown> = {}) {
  return {
    programId,
    amount: 5000,
    idempotencyKey: newKey(),
    recipient: { name: "Rita Recipient", email: "Rita@Example.com" },
    senderName: "Sam Sender",
    message: "Happy holidays",
    ...overrides,
  };
}

function issue(headers: Headers, payload: Record<string, unknown>) {
  return send(getApp(), { method: "POST", url: "/gift-cards", headers, payload });
}

async function issueOk(headers: Headers, programId: string, overrides: Record<string, unknown> = {}) {
  const res = await issue(headers, issueBody(programId, overrides));
  assert.equal(res.statusCode, 201, res.body);
  return res.json<CardWithDelivery>();
}

function get(headers: Headers, url: string) {
  return send(getApp(), { method: "GET", url, headers });
}

function action(headers: Headers, id: string, name: "suspend" | "resume" | "void" | "unlock") {
  return send(getApp(), { method: "POST", url: `/gift-cards/${id}/${name}`, headers });
}

async function cardCount(): Promise<number> {
  const [row] = (await adminQuery(`SELECT count(*)::int AS n FROM gift_cards`)) as { n: number }[];
  return row.n;
}

async function auditActions(): Promise<string[]> {
  const rows = (await adminQuery(
    `SELECT action FROM audit_logs WHERE action LIKE 'gift_card.%' ORDER BY created_at, id`
  )) as { action: string }[];
  return rows.map((r) => r.action);
}

async function ledger(cardId: string): Promise<{ type: string; amount: number; balance_after: number }[]> {
  return (await adminQuery(
    `SELECT type, amount, balance_after FROM gift_card_transactions WHERE gift_card_id = $1 ORDER BY created_at, id`,
    [cardId]
  )) as { type: string; amount: number; balance_after: number }[];
}

function replayed(res: LightMyRequestResponse): boolean {
  return res.headers["idempotent-replayed"] === "true";
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

// ---------- issue ----------

test("issue returns last4 only and the delivery; the number and PIN exist only as ciphertext", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin);
  const res = await issue(a.admin, issueBody(programId));
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.headers["idempotent-replayed"], undefined);
  const { card, delivery } = res.json<CardWithDelivery>();

  assert.deepEqual(Object.keys(card).sort(), CARD_KEYS);
  assert.deepEqual(Object.keys(delivery).sort(), DELIVERY_KEYS);
  assert.match(card.id, UUID_V7);
  assert.equal(card.programId, programId);
  assert.match(card.referenceNumber, /^[0-9A-HJKMNP-TV-Z]{12}$/);
  assert.match(card.last4, /^[0-9]{4}$/);
  assert.equal(card.currency, "CAD");
  assert.equal(card.currencyExponent, 2);
  assert.equal(card.initialAmount, 5000);
  assert.equal(card.balance, 5000);
  assert.equal(card.status, "active");
  assert.equal(card.hasPin, true);
  assert.equal(card.expiresAt, null);
  assert.equal(card.pinLocked, false);
  assert.deepEqual(
    { ...delivery, id: undefined, sendAt: undefined },
    {
      id: undefined,
      recipientName: "Rita Recipient",
      recipientEmail: "rita@example.com", // normalized
      senderName: "Sam Sender",
      message: "Happy holidays",
      sendAt: undefined,
      status: "scheduled",
      attempts: 0,
      sentAt: null,
      openedAt: null,
      revealCount: 0,
      lastRevealedAt: null,
    }
  );

  // Decrypt the stored secrets with the test keys: a well-formed number that ends in last4, and a PIN
  const config = loadTestConfig();
  const crypto = new CardCrypto({ encryption: config.cardEncryptionKey, lookup: config.cardLookupKey });
  const [row] = (await adminQuery(
    `SELECT card_number_enc, card_number_hmac, pin_enc, card_number_last4, encryption_key_id, lookup_key_id, issued_by
       FROM gift_cards WHERE id = $1`,
    [card.id]
  )) as {
    card_number_enc: Buffer;
    card_number_hmac: Buffer;
    pin_enc: Buffer;
    card_number_last4: string;
    encryption_key_id: number;
    lookup_key_id: number;
    issued_by: string;
  }[];
  const ids = { tenantId: a.signup.tenantId, cardId: card.id };
  const number = crypto.decrypt("number", ids, row.encryption_key_id, row.card_number_enc);
  const pin = crypto.decrypt("pin", ids, row.encryption_key_id, row.pin_enc);
  assert.match(number, /^7000[0-9]{12}$/);
  assert.ok(isLuhnValid(number));
  assert.equal(number.slice(-4), card.last4);
  assert.match(pin, /^[0-9]{6}$/);
  assert.ok(row.card_number_hmac.equals(crypto.lookupHash(number)));
  assert.equal(row.issued_by, a.signup.adminId);
  assert.ok(!row.card_number_enc.includes(Buffer.from(number)), "the number is not in the ciphertext");
  for (const secret of [number, pin]) assert.ok(!res.body.includes(secret), "no response carries the number or PIN");

  assert.deepEqual(await ledger(card.id), [{ type: "issue", amount: 5000, balance_after: 5000 }]);
  assert.deepEqual(await auditActions(), ["gift_card.issued"]);
  const [audit] = (await adminQuery(
    `SELECT user_id, details FROM audit_logs WHERE action = 'gift_card.issued'`
  )) as { user_id: string; details: unknown }[];
  assert.equal(audit.user_id, a.signup.adminId);
  assert.deepEqual(audit.details, { giftCardId: card.id, programId, amount: 5000 });
});

test("a PIN-less program issues a card with no PIN", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin, { name: "No PIN", pinRequired: false, cardNumberLength: 19 });
  const { card } = await issueOk(a.admin, programId);
  assert.equal(card.hasPin, false);
  const [row] = (await adminQuery(`SELECT pin_enc FROM gift_cards WHERE id = $1`, [card.id])) as {
    pin_enc: Buffer | null;
  }[];
  assert.equal(row.pin_enc, null);
});

test("issue replay: 200 with the header, the same card and delivery, nothing new written", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin);
  const body = issueBody(programId);
  const first = await issue(a.admin, body);
  assert.equal(first.statusCode, 201, first.body);
  const second = await issue(a.admin, body);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(replayed(second), true);
  assert.deepEqual(second.json(), first.json());

  assert.equal(await cardCount(), 1);
  assert.equal((await ledger(first.json<CardWithDelivery>().card.id)).length, 1);
  assert.deepEqual(await auditActions(), ["gift_card.issued"]);
});

test("replay compares the normalized request: email case and whitespace do not matter", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin);
  const body = issueBody(programId);
  assert.equal((await issue(a.admin, body)).statusCode, 201);
  const again = await issue(a.admin, { ...body, recipient: { name: "Rita Recipient", email: "  rita@EXAMPLE.com " } });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(replayed(again), true);
});

test("same key with a different body -> 409, nothing written", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin);
  const body = issueBody(programId);
  assert.equal((await issue(a.admin, body)).statusCode, 201);
  for (const change of [{ amount: 5001 }, { senderName: "Someone Else" }, { message: "Other" }, { sendAt: "2030-01-01T00:00:00Z" }]) {
    const res = await issue(a.admin, { ...body, ...change });
    assert.equal(res.statusCode, 409, res.body);
    assert.deepEqual(res.json(), { error: "Idempotency key already used with a different request" });
  }
  assert.equal(await cardCount(), 1);
});

test("another user reusing the key -> 409, not a replay of the first user's card", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin, { staffDailyIssueLimit: 100000 });
  const body = issueBody(programId);
  assert.equal((await issue(a.admin, body)).statusCode, 201);
  const res = await issue(a.staff, body);
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(replayed(res), false);
  assert.equal(await cardCount(), 1);
});

test("retry after the program is retired -> 200 replay; a new key -> 409", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin);
  const body = issueBody(programId);
  assert.equal((await issue(a.admin, body)).statusCode, 201);
  assert.equal((await patchProgram(a.admin, programId, { status: "retired" })).statusCode, 200);

  const retry = await issue(a.admin, body);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(replayed(retry), true);
  const fresh = await issue(a.admin, issueBody(programId));
  assert.equal(fresh.statusCode, 409, fresh.body);
  assert.deepEqual(fresh.json(), { error: "Program is retired" });
});

test("retry after max_value is lowered -> 200 replay; a new key above it -> 400", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin);
  const body = issueBody(programId, { amount: 5000 });
  assert.equal((await issue(a.admin, body)).statusCode, 201);
  assert.equal((await patchProgram(a.admin, programId, { maxValue: 1000 })).statusCode, 200);

  const retry = await issue(a.admin, body);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(replayed(retry), true);
  const fresh = await issue(a.admin, issueBody(programId, { amount: 5000 }));
  assert.equal(fresh.statusCode, 400, fresh.body);
});

test("concurrent same-key admin issues: exactly one 201 and one 200 replay, one card", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin);
  const body = issueBody(programId);
  const [r1, r2] = await Promise.all([issue(a.admin, body), issue(a.admin, body)]);

  assert.deepEqual([r1.statusCode, r2.statusCode].sort(), [200, 201]);
  const [created, replay] = r1.statusCode === 201 ? [r1, r2] : [r2, r1];
  assert.equal(replayed(replay), true);
  assert.equal(replayed(created), false);
  assert.equal(replay.json<CardWithDelivery>().card.id, created.json<CardWithDelivery>().card.id);
  assert.equal(await cardCount(), 1);
  assert.deepEqual(await auditActions(), ["gift_card.issued"]);
});

test("issue: idempotency 23505 after rollback replays (staged on a held unique key)", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin);
  const body = issueBody(programId);

  // An uncommitted winner: a card, its issue ledger row with this key and the request's hash, a delivery
  const tx = await openAdminTransaction();
  let fixtureCardId: string;
  try {
    const [card] = (await tx.query(
      `INSERT INTO gift_cards (tenant_id, program_id, currency, reference_number, card_number_enc,
          card_number_hmac, card_number_last4, pin_enc, encryption_key_id, lookup_key_id, initial_amount,
          balance, status, issued_by)
       VALUES ($1, $2, 'CAD', 'ZZZZZZZZZZZZ', $3, $4, '4321', $3, 1, 1, 5000, 5000, 'active', $5) RETURNING id`,
      [a.signup.tenantId, programId, Buffer.from("fixture"), randomBytes(32), a.signup.adminId]
    )) as { id: string }[];
    fixtureCardId = card.id;
    await tx.query(
      `INSERT INTO gift_card_transactions (tenant_id, gift_card_id, currency, type, amount, balance_after,
          idempotency_key, request_hash, actor_user_id)
       VALUES ($1, $2, 'CAD', 'issue', 5000, 5000, $3, $4, $5)`,
      [
        a.signup.tenantId,
        fixtureCardId,
        body.idempotencyKey,
        requestHashIssue({
          actorUserId: a.signup.adminId,
          programId,
          amount: body.amount,
          recipientEmail: "rita@example.com",
          recipientName: body.recipient.name,
          senderName: body.senderName,
          message: body.message,
        }),
        a.signup.adminId,
      ]
    );
    await tx.query(
      `INSERT INTO gift_card_deliveries (tenant_id, gift_card_id, recipient_name, recipient_email, sender_name,
          message, send_at, status, next_attempt_at, created_by)
       VALUES ($1, $2, $3, 'rita@example.com', $4, $5, now(), 'scheduled', now(), $6)`,
      [a.signup.tenantId, fixtureCardId, body.recipient.name, body.senderName, body.message, a.signup.adminId]
    );

    // The request cannot see the uncommitted row, so it runs to its ledger insert and blocks there
    const pending = issue(a.admin, body);
    await waitUntilBlocked(adminQuery, 1);
    await tx.commit();

    const res = await pending;
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(replayed(res), true);
    assert.equal(res.json<CardWithDelivery>().card.id, fixtureCardId);
  } finally {
    await tx.rollback();
  }
  assert.equal(await cardCount(), 1, "the rolled-back attempt left no card behind");
});

test("issue: a key committed concurrently for a different request -> 409 (staged)", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin);
  const body = issueBody(programId);

  const tx = await openAdminTransaction();
  try {
    const [card] = (await tx.query(
      `INSERT INTO gift_cards (tenant_id, program_id, currency, reference_number, card_number_enc,
          card_number_hmac, card_number_last4, pin_enc, encryption_key_id, lookup_key_id, initial_amount,
          balance, status, issued_by)
       VALUES ($1, $2, 'CAD', 'ZZZZZZZZZZZZ', $3, $4, '4321', $3, 1, 1, 700, 700, 'active', $5) RETURNING id`,
      [a.signup.tenantId, programId, Buffer.from("fixture"), randomBytes(32), a.signup.adminId]
    )) as { id: string }[];
    await tx.query(
      `INSERT INTO gift_card_transactions (tenant_id, gift_card_id, currency, type, amount, balance_after,
          idempotency_key, request_hash, actor_user_id)
       VALUES ($1, $2, 'CAD', 'issue', 700, 700, $3, $4, $5)`,
      [a.signup.tenantId, card.id, body.idempotencyKey, randomBytes(32), a.signup.adminId]
    );
    await tx.query(
      `INSERT INTO gift_card_deliveries (tenant_id, gift_card_id, recipient_name, recipient_email, sender_name,
          send_at, status, next_attempt_at, created_by)
       VALUES ($1, $2, 'Other', 'other@example.com', 'Other', now(), 'scheduled', now(), $3)`,
      [a.signup.tenantId, card.id, a.signup.adminId]
    );
    const pending = issue(a.admin, body);
    await waitUntilBlocked(adminQuery, 1);
    await tx.commit();
    const res = await pending;
    assert.equal(res.statusCode, 409, res.body);
    assert.deepEqual(res.json(), { error: "Idempotency key already used with a different request" });
  } finally {
    await tx.rollback();
  }
  assert.equal(await cardCount(), 1);
});

test("an unknown program, or another tenant's, -> 404", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const b = await setupTenant("beta", "bob@beta.com");
  const bProgram = await createProgram(b.admin);
  assert.equal((await issue(a.admin, issueBody(bProgram))).statusCode, 404);
  assert.equal((await issue(a.admin, issueBody("0198a7a0-0000-7000-8000-000000000000"))).statusCode, 404);
  assert.equal(await cardCount(), 0);
});

// ---------- staff and admin rules ----------

test("staff cannot issue a promotional card; staff cannot issue without a limit", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const promo = await createProgram(a.admin, { name: "Promo", cardType: "promotional" });
  const noLimit = await createProgram(a.admin, { name: "No limit" });
  const promoRes = await issue(a.staff, issueBody(promo));
  assert.equal(promoRes.statusCode, 403, promoRes.body);
  const limitRes = await issue(a.staff, issueBody(noLimit));
  assert.equal(limitRes.statusCode, 403, limitRes.body);
  assert.equal(await cardCount(), 0);
  // The admin can issue promotional cards
  assert.equal((await issue(a.admin, issueBody(promo))).statusCode, 201);
});

test("staff limit: up to the limit succeeds, the next is 403; the admin is not subject to it", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin, { staffDailyIssueLimit: 1000 });
  assert.equal((await issue(a.staff, issueBody(programId, { amount: 600 }))).statusCode, 201);
  assert.equal((await issue(a.staff, issueBody(programId, { amount: 400 }))).statusCode, 201);
  const over = await issue(a.staff, issueBody(programId, { amount: 1 }));
  assert.equal(over.statusCode, 403, over.body);
  assert.deepEqual(over.json(), { error: "Daily staff issue limit reached" });
  assert.equal(await cardCount(), 2);

  for (let i = 0; i < 3; i++) assert.equal((await issue(a.admin, issueBody(programId, { amount: 5000 }))).statusCode, 201);
});

test("staff limit: concurrent staff issues cannot exceed it", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin, { staffDailyIssueLimit: 1000 });
  const results = await Promise.all(
    Array.from({ length: 5 }, () => issue(a.staff, issueBody(programId, { amount: 300 })))
  );
  const statuses = results.map((r) => r.statusCode).sort();
  assert.deepEqual(statuses, [201, 201, 201, 403, 403]);
  const [row] = (await adminQuery(`SELECT COALESCE(SUM(initial_amount), 0)::int AS total FROM gift_cards`)) as {
    total: number;
  }[];
  assert.equal(row.total, 900);
});

test("staff limit: a concurrent same-key retry at the cap replays (200, one card) (staged on the advisory lock)", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin, { staffDailyIssueLimit: 500 });
  const body = issueBody(programId, { amount: 500 });

  // Hold the staff user's issue lock, as an earlier in-flight issue would
  const tx = await openAdminTransaction();
  try {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [
      `gift-card-issue:${programId}:${a.staffId}`,
    ]);
    const first = issue(a.staff, body);
    await waitUntilBlocked(adminQuery, 1);
    const retry = issue(a.staff, body);
    await waitUntilBlocked(adminQuery, 2);
    await tx.commit();

    const [r1, r2] = [await first, await retry];
    assert.equal(r1.statusCode, 201, r1.body);
    assert.equal(r2.statusCode, 200, r2.body);
    assert.equal(replayed(r2), true);
    assert.equal(r2.json<CardWithDelivery>().card.id, r1.json<CardWithDelivery>().card.id);
  } finally {
    await tx.rollback();
  }
  assert.equal(await cardCount(), 1);
});

test("the staff issue lock is per user and program: another user's issue is not blocked by it", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin, { staffDailyIssueLimit: 5000 });
  const tx = await openAdminTransaction();
  try {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [
      `gift-card-issue:${programId}:${a.staffId}`,
    ]);
    // The admin takes no advisory lock, so it completes while the staff lock is held
    assert.equal((await issue(a.admin, issueBody(programId))).statusCode, 201);
  } finally {
    await tx.rollback();
  }
});

test("amount over max_value -> 400; a bad shape -> 400", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin, { maxValue: 2000 });
  assert.equal((await issue(a.admin, issueBody(programId, { amount: 2001 }))).statusCode, 400);
  assert.equal((await issue(a.admin, issueBody(programId, { amount: 2000 }))).statusCode, 201);

  for (const bad of [
    { amount: 0 },
    { amount: 1.5 },
    { amount: "5000" },
    { amount: 2147483648 },
    { idempotencyKey: "short" },
    { idempotencyKey: "has spaces in it, sixteen+" },
    { programId: "not-a-uuid" },
    { recipient: { name: "R", email: "not-an-email" } },
    { recipient: { name: "R" } },
    { recipient: { name: "R", email: "r@example.com", extra: 1 } },
    { senderName: "" },
    { senderName: "bad\u0007name" },
    { message: "x".repeat(501) },
    { message: "bell\u0007" },
    { sendAt: "tomorrow" },
    { extra: true },
  ]) {
    const res = await issue(a.admin, issueBody(programId, bad));
    assert.equal(res.statusCode, 400, `${JSON.stringify(bad)} -> ${res.statusCode} ${res.body}`);
  }
  assert.equal(await cardCount(), 1);
});

test("a message may contain newlines; an absent message is stored as null", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin);
  const withLines = await issueOk(a.admin, programId, { message: "line one\nline two" });
  assert.equal(withLines.delivery.message, "line one\nline two");
  const body = issueBody(programId);
  delete (body as Record<string, unknown>).message;
  const res = await issue(a.admin, body);
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json<CardWithDelivery>().delivery.message, null);
});

test("promotional expiry sets expires_at from the program", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin, { name: "Promo", cardType: "promotional", expiryMonths: 6 });
  const { card } = await issueOk(a.admin, programId);
  assert.ok(card.expiresAt, "expiresAt is set");
  const [row] = (await adminQuery(
    `SELECT expires_at BETWEEN now() + interval '5 months 27 days' AND now() + interval '6 months 1 day' AS ok
       FROM gift_cards WHERE id = $1`,
    [card.id]
  )) as { ok: boolean }[];
  assert.equal(row.ok, true);
  assert.equal(card.status, "active");
});

test("sendAt: a future time is kept; beyond 365 days -> 400 with nothing persisted", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin);
  const soon = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
  const { delivery } = await issueOk(a.admin, programId, { sendAt: soon });
  assert.equal(new Date(delivery.sendAt).toISOString(), soon);
  assert.equal(delivery.status, "scheduled");
  const [row] = (await adminQuery(`SELECT send_at = next_attempt_at AS same FROM gift_card_deliveries`)) as {
    same: boolean;
  }[];
  assert.equal(row.same, true);

  const far = new Date(Date.now() + 366 * 24 * 3600 * 1000).toISOString();
  const res = await issue(a.admin, issueBody(programId, { sendAt: far }));
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(await cardCount(), 1, "the failed issue rolled back its card, ledger row and audit row");
  assert.deepEqual(await auditActions(), ["gift_card.issued"]);
});

test("issue and program update serialize: an update that holds the program makes the issue wait, then see it", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin);

  const tx = await openAdminTransaction();
  try {
    await tx.query(`SELECT 1 FROM gift_card_programs WHERE id = $1 FOR UPDATE`, [programId]);
    const pending = issue(a.admin, issueBody(programId));
    await waitUntilBlocked(adminQuery, 1);
    await tx.query(`UPDATE gift_card_programs SET status = 'retired' WHERE id = $1`, [programId]);
    await tx.commit();
    const res = await pending;
    assert.equal(res.statusCode, 409, res.body);
    assert.deepEqual(res.json(), { error: "Program is retired" });
  } finally {
    await tx.rollback();
  }
  assert.equal(await cardCount(), 0);
});

test("issue and program update serialize: an in-flight issue holds the program, so the update then sees the card", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin, { staffDailyIssueLimit: 5000 });

  // Hold the staff issue lock so the issue stops after it has locked the program FOR SHARE
  const tx = await openAdminTransaction();
  try {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [
      `gift-card-issue:${programId}:${a.staffId}`,
    ]);
    const issuePending = issue(a.staff, issueBody(programId));
    await waitUntilBlocked(adminQuery, 1);
    // An immutable field: the update must wait for the issue, then find the card and answer 409
    const patchPending = patchProgram(a.admin, programId, { cardNumberPrefix: "7100" });
    await waitUntilBlocked(adminQuery, 2);
    await tx.commit();

    const [issued, patched] = [await issuePending, await patchPending];
    assert.equal(issued.statusCode, 201, issued.body);
    assert.equal(patched.statusCode, 409, patched.body);
  } finally {
    await tx.rollback();
  }
  const [row] = (await adminQuery(`SELECT card_number_prefix FROM gift_card_programs WHERE id = $1`, [programId])) as {
    card_number_prefix: string;
  }[];
  assert.equal(row.card_number_prefix, "7000");
});

test("per-user rate limit: 60 issues per minute each; one user's count does not affect another", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  // An invalid body is cheap and still counts: the limiter runs before validation
  for (let i = 1; i <= 60; i++) {
    const res = await issue(a.admin, {});
    assert.equal(res.statusCode, 400, `request ${i}`);
  }
  const limited = await issue(a.admin, {});
  assert.equal(limited.statusCode, 429, limited.body);
  const other = await issue(a.staff, {});
  assert.equal(other.statusCode, 400, "the staff user has an independent counter");
});

test("issue requires authentication and a role", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin);
  const anon = await send(getApp(), { method: "POST", url: "/gift-cards", payload: issueBody(programId) });
  assert.equal(anon.statusCode, 401);
});

// ---------- reads ----------

test("get by id, and by reference with or without hyphens or in lower case", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin);
  const issued = await issueOk(a.admin, programId);
  const { card } = issued;

  for (const headers of [a.admin, a.staff]) {
    const byId = await get(headers, `/gift-cards/${card.id}`);
    assert.equal(byId.statusCode, 200, byId.body);
    assert.deepEqual(byId.json<CardWithDelivery>().card, card);
    assert.deepEqual(Object.keys(byId.json<CardWithDelivery>().card).sort(), CARD_KEYS);
    assert.deepEqual(byId.json<CardWithDelivery>().delivery, issued.delivery);
  }

  const ref = card.referenceNumber;
  const hyphenated = `${ref.slice(0, 4)}-${ref.slice(4, 8)}-${ref.slice(8)}`;
  for (const variant of [ref, hyphenated, hyphenated.toLowerCase()]) {
    const res = await get(a.staff, `/gift-cards/by-reference/${variant}`);
    assert.equal(res.statusCode, 200, `${variant}: ${res.body}`);
    assert.equal(res.json<CardWithDelivery>().card.id, card.id);
  }
  assert.equal((await get(a.admin, "/gift-cards/by-reference/NOTAREFERENCE!")).statusCode, 404);
  assert.equal((await get(a.admin, "/gift-cards/by-reference/ZZZZZZZZZZZZ")).statusCode, 404);
  assert.equal((await get(a.admin, "/gift-cards/0198a7a0-0000-7000-8000-000000000000")).statusCode, 404);
  assert.equal((await get(a.admin, "/gift-cards/not-a-uuid")).statusCode, 400);
});

test("another tenant's card is a 404 for every read and admin action", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const b = await setupTenant("beta", "bob@beta.com");
  const programId = await createProgram(a.admin);
  const { card } = await issueOk(a.admin, programId);

  assert.equal((await get(b.admin, `/gift-cards/${card.id}`)).statusCode, 404);
  assert.equal((await get(b.admin, `/gift-cards/by-reference/${card.referenceNumber}`)).statusCode, 404);
  assert.equal((await get(b.admin, `/gift-cards/${card.id}/transactions`)).statusCode, 404);
  for (const name of ["suspend", "resume", "void", "unlock"] as const) {
    assert.equal((await action(b.admin, card.id, name)).statusCode, 404, name);
  }
  const [row] = (await adminQuery(`SELECT status, balance FROM gift_cards WHERE id = $1`, [card.id])) as {
    status: string;
    balance: number;
  }[];
  assert.deepEqual(row, { status: "active", balance: 5000 });
});

test("transactions list: the issue row, newest last, exact keys", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin);
  const { card } = await issueOk(a.admin, programId);
  assert.equal((await action(a.admin, card.id, "void")).statusCode, 200);

  for (const headers of [a.admin, a.staff]) {
    const res = await get(headers, `/gift-cards/${card.id}/transactions`);
    assert.equal(res.statusCode, 200, res.body);
    const rows = res.json<TransactionDto[]>();
    assert.deepEqual(rows.map((r) => [r.type, r.amount, r.balanceAfter]), [
      ["issue", 5000, 5000],
      ["void", 5000, 0],
    ]);
    for (const r of rows) {
      assert.deepEqual(
        Object.keys(r).sort(),
        [
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
        ].sort()
      );
      assert.equal(r.giftCardId, card.id);
      assert.equal(r.currency, "CAD");
      assert.equal(r.actorUserId, a.signup.adminId);
      assert.equal(r.relatedTransactionId, null);
    }
    assert.ok(!res.body.includes("requestHash") && !res.body.includes("idempotency"));
  }
});

test("a card past its expiry reads as expired", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin);
  const { card } = await issueOk(a.admin, programId);
  await adminQuery(`UPDATE gift_cards SET expires_at = now() - interval '1 day' WHERE id = $1`, [card.id]);
  const res = await get(a.staff, `/gift-cards/${card.id}`);
  assert.equal(res.json<CardWithDelivery>().card.status, "expired");
  assert.equal(res.json<CardWithDelivery>().card.balance, 5000);
});

// ---------- admin state changes ----------

test("suspend / resume / void / unlock: transitions, idempotent repeats, one audit row per change", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin);
  const { card } = await issueOk(a.admin, programId);

  const suspended = await action(a.admin, card.id, "suspend");
  assert.equal(suspended.statusCode, 200, suspended.body);
  assert.equal(suspended.json<CardWithDelivery>().card.status, "suspended");
  assert.deepEqual(Object.keys(suspended.json<CardWithDelivery>().card).sort(), CARD_KEYS);
  assert.equal((await action(a.admin, card.id, "suspend")).statusCode, 200, "suspend on suspended");

  const resumed = await action(a.admin, card.id, "resume");
  assert.equal(resumed.statusCode, 200, resumed.body);
  assert.equal(resumed.json<CardWithDelivery>().card.status, "active");
  assert.equal((await action(a.admin, card.id, "resume")).statusCode, 200, "resume on active");

  // A locked card: unlock clears it
  await adminQuery(
    `UPDATE gift_cards SET failed_pin_attempts = 3, pin_locked_until = now() + interval '20 minutes' WHERE id = $1`,
    [card.id]
  );
  assert.equal((await get(a.admin, `/gift-cards/${card.id}`)).json<CardWithDelivery>().card.pinLocked, true);
  const unlocked = await action(a.admin, card.id, "unlock");
  assert.equal(unlocked.statusCode, 200, unlocked.body);
  assert.equal(unlocked.json<CardWithDelivery>().card.pinLocked, false);
  const [lock] = (await adminQuery(`SELECT failed_pin_attempts, pin_locked_until FROM gift_cards WHERE id = $1`, [
    card.id,
  ])) as { failed_pin_attempts: number; pin_locked_until: Date | null }[];
  assert.deepEqual(lock, { failed_pin_attempts: 0, pin_locked_until: null });

  const voided = await action(a.admin, card.id, "void");
  assert.equal(voided.statusCode, 200, voided.body);
  assert.equal(voided.json<CardWithDelivery>().card.status, "voided");
  assert.equal(voided.json<CardWithDelivery>().card.balance, 0);
  assert.equal((await action(a.admin, card.id, "void")).statusCode, 200, "void on voided");

  // A voided card accepts no other change, except unlock (any status)
  for (const name of ["suspend", "resume"] as const) {
    const res = await action(a.admin, card.id, name);
    assert.equal(res.statusCode, 409, `${name}: ${res.body}`);
    assert.deepEqual(res.json(), { error: "Card is not active" });
  }
  assert.equal((await action(a.admin, card.id, "unlock")).statusCode, 200);

  assert.deepEqual(await auditActions(), [
    "gift_card.issued",
    "gift_card.suspended",
    "gift_card.resumed",
    "gift_card.unlocked",
    "gift_card.voided",
    "gift_card.unlocked",
  ]);
  const [voidAudit] = (await adminQuery(
    `SELECT user_id, details FROM audit_logs WHERE action = 'gift_card.voided'`
  )) as { user_id: string; details: unknown }[];
  assert.equal(voidAudit.user_id, a.signup.adminId);
  assert.deepEqual(voidAudit.details, { giftCardId: card.id, voidedAmount: 5000 });
});

test("only an admin can suspend, resume, void or unlock", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin);
  const { card } = await issueOk(a.admin, programId);
  for (const name of ["suspend", "resume", "void", "unlock"] as const) {
    assert.equal((await action(a.staff, card.id, name)).statusCode, 403, name);
    const anon = await send(getApp(), { method: "POST", url: `/gift-cards/${card.id}/${name}` });
    assert.equal(anon.statusCode, 401, name);
  }
  assert.equal((await get(a.admin, `/gift-cards/${card.id}`)).json<CardWithDelivery>().card.status, "active");
});

test("an effectively expired card: suspend and resume -> 409 'Card has expired'; void still works", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin);
  const { card } = await issueOk(a.admin, programId);
  await adminQuery(`UPDATE gift_cards SET expires_at = now() - interval '1 day' WHERE id = $1`, [card.id]);
  for (const name of ["suspend", "resume"] as const) {
    const res = await action(a.admin, card.id, name);
    assert.equal(res.statusCode, 409, res.body);
    assert.deepEqual(res.json(), { error: "Card has expired" });
  }
  const voided = await action(a.admin, card.id, "void");
  assert.equal(voided.statusCode, 200, voided.body);
  assert.equal(voided.json<CardWithDelivery>().card.status, "voided");
  assert.deepEqual((await ledger(card.id)).map((r) => r.type), ["issue", "void"]);
});

test("a depleted card cannot be suspended", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin);
  const { card } = await issueOk(a.admin, programId);
  // Spend the card as the redeem path will: ledger row first, then the card row
  await adminQuery(
    `INSERT INTO gift_card_transactions (tenant_id, gift_card_id, currency, type, amount, balance_after,
        idempotency_key, request_hash, actor_user_id)
     VALUES ($1, $2, 'CAD', 'redeem', 5000, 0, $3, $4, $5)`,
    [a.signup.tenantId, card.id, newKey(), randomBytes(32), a.signup.adminId]
  );
  await adminQuery(`UPDATE gift_cards SET balance = 0, status = 'depleted' WHERE id = $1`, [card.id]);
  const res = await action(a.admin, card.id, "suspend");
  assert.equal(res.statusCode, 409, res.body);
  assert.deepEqual(res.json(), { error: "Card is not active" });
});

test("void writes the void ledger row for the remaining balance, cancels the delivery and clears its token", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin);
  const { card, delivery } = await issueOk(a.admin, programId, { amount: 4200 });
  // As if the delivery had been sent: a live token on a non-cancelled delivery
  await adminQuery(
    `UPDATE gift_card_deliveries SET status = 'sent', sent_at = now(), token_hash = $2,
        token_expires_at = now() + interval '90 days' WHERE id = $1`,
    [delivery.id, randomBytes(32)]
  );

  const res = await action(a.admin, card.id, "void");
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json<CardWithDelivery>();
  assert.equal(body.card.status, "voided");
  assert.equal(body.card.balance, 0);
  assert.equal(body.delivery.status, "cancelled");

  assert.deepEqual(await ledger(card.id), [
    { type: "issue", amount: 4200, balance_after: 4200 },
    { type: "void", amount: 4200, balance_after: 0 },
  ]);
  const [void_row] = (await adminQuery(
    `SELECT idempotency_key, request_hash, actor_user_id FROM gift_card_transactions
      WHERE gift_card_id = $1 AND type = 'void'`,
    [card.id]
  )) as { idempotency_key: string | null; request_hash: Buffer | null; actor_user_id: string }[];
  assert.deepEqual(void_row, { idempotency_key: null, request_hash: null, actor_user_id: a.signup.adminId });
  const [d] = (await adminQuery(
    `SELECT status, claimed_at, token_hash, token_expires_at FROM gift_card_deliveries WHERE id = $1`,
    [delivery.id]
  )) as { status: string; claimed_at: Date | null; token_hash: Buffer | null; token_expires_at: Date | null }[];
  assert.deepEqual(d, { status: "cancelled", claimed_at: null, token_hash: null, token_expires_at: null });

  // Repeating the void adds no ledger row and no audit row
  assert.equal((await action(a.admin, card.id, "void")).statusCode, 200);
  assert.equal((await ledger(card.id)).length, 2);
  assert.equal((await auditActions()).filter((x) => x === "gift_card.voided").length, 1);
});

test("void of a card with no balance writes no ledger row", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin);
  const { card } = await issueOk(a.admin, programId);
  await adminQuery(
    `INSERT INTO gift_card_transactions (tenant_id, gift_card_id, currency, type, amount, balance_after,
        idempotency_key, request_hash, actor_user_id)
     VALUES ($1, $2, 'CAD', 'redeem', 5000, 0, $3, $4, $5)`,
    [a.signup.tenantId, card.id, newKey(), randomBytes(32), a.signup.adminId]
  );
  await adminQuery(`UPDATE gift_cards SET balance = 0, status = 'depleted' WHERE id = $1`, [card.id]);

  const res = await action(a.admin, card.id, "void");
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json<CardWithDelivery>().card.status, "voided");
  assert.deepEqual((await ledger(card.id)).map((r) => r.type), ["issue", "redeem"]);
  const [audit] = (await adminQuery(`SELECT details FROM audit_logs WHERE action = 'gift_card.voided'`)) as {
    details: unknown;
  }[];
  assert.deepEqual(audit.details, { giftCardId: card.id, voidedAmount: 0 });
});

test("concurrent voids serialize on the card lock: one void ledger row (staged)", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const programId = await createProgram(a.admin);
  const { card } = await issueOk(a.admin, programId);

  const tx = await openAdminTransaction();
  try {
    await tx.query(`SELECT 1 FROM gift_cards WHERE id = $1 FOR UPDATE`, [card.id]);
    const first = action(a.admin, card.id, "void");
    await waitUntilBlocked(adminQuery, 1);
    const second = action(a.admin, card.id, "void");
    await waitUntilBlocked(adminQuery, 2);
    await tx.commit();
    assert.deepEqual([(await first).statusCode, (await second).statusCode], [200, 200]);
  } finally {
    await tx.rollback();
  }
  assert.deepEqual((await ledger(card.id)).map((r) => r.type), ["issue", "void"]);
  assert.equal((await auditActions()).filter((x) => x === "gift_card.voided").length, 1);
});
