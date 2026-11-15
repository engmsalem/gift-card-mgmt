import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { isLuhnValid } from "../../src/gift-cards/card-number";
import { hashDeliveryToken } from "../../src/gift-cards/delivery-token";
import { dispatchAllDue } from "../../src/scripts/dispatch-deliveries";
import { DeliveryDispatcher, type DispatcherLog } from "../../src/services/deliveryDispatcher";
import {
  adminQuery,
  getAppDataSource,
  send,
  setupTenantActors,
  useTestApp,
  type TenantActors,
} from "./helpers";
import { RecordingDeliverySender } from "../support/recording-delivery-sender";

const LINK_BASE = "http://localhost:3000/gift";

let sender = new RecordingDeliverySender();
const getApp = useTestApp(() => {
  sender = new RecordingDeliverySender();
  return { deliverySender: sender };
});

type Headers = { authorization: string };

interface DeliveryDto {
  id: string;
  recipientName: string;
  recipientEmail: string;
  status: string;
  attempts: number;
  sentAt: string | null;
  openedAt: string | null;
  revealCount: number;
}
interface CardWithDelivery {
  card: { id: string; last4: string };
  delivery: DeliveryDto;
}

const setupTenant = (subdomain: string, email: string): Promise<TenantActors> =>
  setupTenantActors(getApp(), subdomain, email);

async function createProgram(headers: Headers, overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await send(getApp(), {
    method: "POST",
    url: "/gift-card-programs",
    headers,
    payload: {
      name: "Holiday",
      cardType: "paid",
      currency: "CAD",
      country: "CA",
      cardNumberPrefix: "7000",
      cardNumberLength: 16,
      pinRequired: true,
      maxValue: 100000,
      ...overrides,
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json<{ id: string }>().id;
}

async function issueOk(headers: Headers, programId: string, overrides: Record<string, unknown> = {}) {
  const res = await send(getApp(), {
    method: "POST",
    url: "/gift-cards",
    headers,
    payload: {
      programId,
      amount: 5000,
      idempotencyKey: randomBytes(12).toString("hex"),
      recipient: { name: "Rita Recipient", email: "Rita@Example.com" },
      senderName: "Sam Sender",
      message: "Happy holidays",
      ...overrides,
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json<CardWithDelivery>();
}

function reveal(token: string) {
  return send(getApp(), { method: "POST", url: "/gift-card-links/reveal", payload: { token } });
}

function resend(headers: Headers, cardId: string, payload?: Record<string, unknown>) {
  return send(getApp(), { method: "POST", url: `/gift-cards/${cardId}/resend`, headers, payload });
}

function voidCard(headers: Headers, cardId: string) {
  return send(getApp(), { method: "POST", url: `/gift-cards/${cardId}/void`, headers });
}

interface DeliveryRow {
  status: string;
  attempts: number;
  last_error: string | null;
  claimed_at: Date | null;
  sent_at: Date | null;
  token_hash: Buffer | null;
  token_expires_at: Date | null;
  reveal_count: number;
  recipient_email: string;
}

async function deliveryRow(id: string): Promise<DeliveryRow> {
  const [row] = (await adminQuery(
    `SELECT status, attempts, last_error, claimed_at, sent_at, token_hash, token_expires_at, reveal_count,
            recipient_email
       FROM gift_card_deliveries WHERE id = $1`,
    [id]
  )) as DeliveryRow[];
  return row;
}

/**
 * Makes a scheduled delivery due now: its send date has been reached too (a resend keeps a send date
 * that is still ahead, so a due delivery must not have one).
 */
async function makeDue(deliveryId: string): Promise<void> {
  await adminQuery(
    `UPDATE gift_card_deliveries
        SET next_attempt_at = now() - interval '1 second', send_at = LEAST(send_at, now() - interval '1 second')
      WHERE id = $1`,
    [deliveryId]
  );
}

interface CapturedLog {
  level: "info" | "warn";
  obj: object;
  msg: string;
}

function captureLog(): { log: DispatcherLog; lines: CapturedLog[] } {
  const lines: CapturedLog[] = [];
  return {
    lines,
    log: {
      info: (obj, msg) => lines.push({ level: "info", obj, msg }),
      warn: (obj, msg) => lines.push({ level: "warn", obj, msg }),
    },
  };
}

function makeDispatcher(s: RecordingDeliverySender, log: DispatcherLog, sendTimeoutMs?: number): DeliveryDispatcher {
  return new DeliveryDispatcher({ db: getAppDataSource(), sender: s, linkBaseUrl: LINK_BASE, log, sendTimeoutMs });
}

// ---------- dispatch on issue ----------

test("immediate delivery: sent on issue, the link carries the token in the fragment", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const { card, delivery } = await issueOk(a.admin, programId);

  // The 201 reflects the real status, not the in-transaction `scheduled` row
  assert.equal(delivery.status, "sent");
  assert.equal(delivery.attempts, 1);
  assert.ok(delivery.sentAt);

  assert.equal(sender.messages.length, 1);
  const message = sender.messages[0];
  assert.equal(message.deliveryId, delivery.id);
  assert.equal(message.tenantId, a.signup.tenantId);
  assert.deepEqual(message.to, { name: "Rita Recipient", email: "rita@example.com" });
  assert.equal(message.senderName, "Sam Sender");
  assert.equal(message.message, "Happy holidays");
  assert.equal(message.merchantName, "Tenant acme");
  assert.equal(message.programName, "Holiday");
  assert.equal(message.amount, 5000);
  assert.equal(message.currency, "CAD");
  assert.equal(message.currencyExponent, 2);
  assert.match(message.link, /^http:\/\/localhost:3000\/gift#token=[A-Za-z0-9_-]{43}$/);
  assert.ok(!message.link.includes("?"), "the token is not in the query string");

  // Only the SHA-256 of the token is stored, with a 90 day expiry
  const row = await deliveryRow(delivery.id);
  assert.ok(row.token_hash?.equals(hashDeliveryToken(sender.lastToken())));
  const [ttl] = (await adminQuery(
    `SELECT token_expires_at BETWEEN now() + interval '89 days 23 hours' AND now() + interval '90 days 1 hour' AS ok
       FROM gift_card_deliveries WHERE id = $1`,
    [delivery.id]
  )) as { ok: boolean }[];
  assert.equal(ttl.ok, true);
  assert.equal(row.claimed_at, null);

  // GET shows the same real status
  const got = await send(getApp(), { method: "GET", url: `/gift-cards/${card.id}`, headers: a.admin });
  assert.equal(got.json<CardWithDelivery>().delivery.status, "sent");
});

test("scheduled delivery is sent only after next_attempt_at", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const soon = new Date(Date.now() + 3600 * 1000).toISOString();
  const { delivery } = await issueOk(a.admin, programId, { sendAt: soon });
  assert.equal(delivery.status, "scheduled");
  assert.equal(sender.messages.length, 0);

  const dispatcher = makeDispatcher(sender, captureLog().log);
  assert.equal(await dispatcher.dispatch({}), 0, "nothing is due yet");
  assert.equal(sender.messages.length, 0);
  assert.equal((await deliveryRow(delivery.id)).status, "scheduled");

  await makeDue(delivery.id);
  assert.equal(await dispatcher.dispatch({}), 1);
  assert.equal(sender.messages.length, 1);
  const row = await deliveryRow(delivery.id);
  assert.equal(row.status, "sent");
  assert.equal(row.attempts, 1);
  assert.equal(await dispatcher.dispatch({}), 0, "a sent delivery is not claimed again");
});

// ---------- reveal ----------

test("reveal returns number, PIN and balance and counts the reveal", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const { card, delivery } = await issueOk(a.admin, programId, { amount: 4200 });

  const res = await reveal(sender.lastToken());
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers["cache-control"], "no-store");
  const body = res.json<Record<string, unknown>>();
  assert.deepEqual(Object.keys(body).sort(), [
    "balance",
    "cardNumber",
    "currency",
    "currencyExponent",
    "expiresAt",
    "merchantName",
    "message",
    "pin",
    "programName",
    "recipientName",
    "senderName",
    "status",
  ]);
  assert.match(body.cardNumber as string, /^7000[0-9]{12}$/);
  assert.ok(isLuhnValid(body.cardNumber as string));
  assert.equal((body.cardNumber as string).slice(-4), card.last4);
  assert.match(body.pin as string, /^[0-9]{6}$/);
  assert.equal(body.balance, 4200);
  assert.equal(body.currency, "CAD");
  assert.equal(body.currencyExponent, 2);
  assert.equal(body.status, "active");
  assert.equal(body.expiresAt, null);
  assert.equal(body.programName, "Holiday");
  assert.equal(body.merchantName, "Tenant acme");
  assert.equal(body.recipientName, "Rita Recipient");
  assert.equal(body.senderName, "Sam Sender");
  assert.equal(body.message, "Happy holidays");

  // Reusable until it expires; each reveal is counted
  const again = await reveal(sender.lastToken());
  assert.equal(again.statusCode, 200);
  assert.equal(again.json<{ cardNumber: string }>().cardNumber, body.cardNumber);
  assert.equal((await deliveryRow(delivery.id)).reveal_count, 2);
  const got = await send(getApp(), { method: "GET", url: `/gift-cards/${card.id}`, headers: a.admin });
  const seen = got.json<CardWithDelivery>().delivery;
  assert.equal(seen.revealCount, 2);
  assert.ok(seen.openedAt);
});

test("reveal of a PIN-less program returns pin null", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin, { pinRequired: false, cardNumberLength: 19 });
  await issueOk(a.admin, programId);
  const res = await reveal(sender.lastToken());
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json<{ pin: string | null }>().pin, null);
});

test("reveal: an expired token, an unknown token and a malformed token", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const { delivery } = await issueOk(a.admin, programId);
  const token = sender.lastToken();

  await adminQuery(
    `UPDATE gift_card_deliveries SET token_expires_at = now() - interval '1 second' WHERE id = $1`,
    [delivery.id]
  );
  const expired = await reveal(token);
  assert.equal(expired.statusCode, 404);
  assert.deepEqual(expired.json(), { error: "Link is invalid or has expired" });
  assert.equal(expired.headers["cache-control"], "no-store");

  const unknown = await reveal(randomBytes(32).toString("base64url"));
  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(unknown.json(), { error: "Link is invalid or has expired" });

  const malformed = await reveal("not-a-token");
  assert.equal(malformed.statusCode, 400);
  assert.equal((await deliveryRow(delivery.id)).reveal_count, 0);
});

test("reveal is limited to 30 per minute per IP", async () => {
  const token = randomBytes(32).toString("base64url");
  for (let i = 0; i < 30; i++) assert.equal((await reveal(token)).statusCode, 404);
  assert.equal((await reveal(token)).statusCode, 429);
});

// ---------- resend ----------

test("resend invalidates the old token; the new one works; audited", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const { card, delivery } = await issueOk(a.admin, programId);
  const oldToken = sender.lastToken();
  assert.equal((await reveal(oldToken)).statusCode, 200);

  const res = await resend(a.admin, card.id);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json<{ delivery: DeliveryDto }>();
  assert.equal(body.delivery.id, delivery.id);
  assert.equal(body.delivery.status, "sent", "the response reflects the real status");
  assert.equal(body.delivery.attempts, 1, "attempts restart");
  assert.equal(sender.messages.length, 2);
  const newToken = sender.lastToken();
  assert.notEqual(newToken, oldToken);

  assert.equal((await reveal(oldToken)).statusCode, 404);
  assert.equal((await reveal(newToken)).statusCode, 200);

  const rows = (await adminQuery(
    `SELECT user_id, details FROM audit_logs WHERE action = 'gift_card_delivery.resent'`
  )) as { user_id: string; details: Record<string, unknown> }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, a.signup.adminId);
  assert.deepEqual(rows[0].details, { giftCardId: card.id, deliveryId: delivery.id, recipientChanged: false });
});

test("resend with no body, and with a body that does not change the recipient, works for staff", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const { card } = await issueOk(a.admin, programId);

  assert.equal((await resend(a.staff, card.id)).statusCode, 200);
  const same = await resend(a.staff, card.id, { recipient: { email: " RITA@example.com ", name: "Rita Recipient" } });
  assert.equal(same.statusCode, 200, same.body);
  assert.equal(sender.messages.length, 3);
});

test("staff cannot change the recipient on a resend", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const { card, delivery } = await issueOk(a.admin, programId);
  const token = sender.lastToken();

  const byEmail = await resend(a.staff, card.id, { recipient: { email: "mallory@example.com" } });
  assert.equal(byEmail.statusCode, 403, byEmail.body);
  const byName = await resend(a.staff, card.id, { recipient: { name: "Mallory" } });
  assert.equal(byName.statusCode, 403, byName.body);

  // Nothing changed or was sent: the original link still works
  assert.equal(sender.messages.length, 1);
  assert.equal((await deliveryRow(delivery.id)).recipient_email, "rita@example.com");
  assert.equal((await reveal(token)).statusCode, 200);
});

test("admin recipient change goes to the new address and audits masked emails only", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const { card, delivery } = await issueOk(a.admin, programId);

  const res = await resend(a.admin, card.id, { recipient: { name: "Bo New", email: "Bob.New@Other.example" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json<{ delivery: DeliveryDto }>().delivery.recipientEmail, "bob.new@other.example");
  assert.deepEqual(sender.messages[1].to, { name: "Bo New", email: "bob.new@other.example" });

  const [audit] = (await adminQuery(
    `SELECT details FROM audit_logs WHERE action = 'gift_card_delivery.resent'`
  )) as { details: Record<string, unknown> }[];
  assert.deepEqual(audit.details, {
    giftCardId: card.id,
    deliveryId: delivery.id,
    recipientChanged: true,
    previousRecipient: "r***@example.com",
    newRecipient: "b***@other.example",
  });
  assert.ok(!JSON.stringify(audit.details).includes("rita"));
  assert.ok(!JSON.stringify(audit.details).includes("bob.new"));

  const bad = await resend(a.admin, card.id, { recipient: { email: "not-an-email" } });
  assert.equal(bad.statusCode, 400, bad.body);
});

test("resend: another tenant -> 404, rate limit 10/min per user", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const b = await setupTenant("beta", "bea@beta.example");
  const programId = await createProgram(a.admin);
  const { card } = await issueOk(a.admin, programId);

  assert.equal((await resend(b.admin, card.id)).statusCode, 404);

  for (let i = 0; i < 10; i++) assert.equal((await resend(a.admin, card.id)).statusCode, 200);
  assert.equal((await resend(a.admin, card.id)).statusCode, 429);
  // The limit is per user: another user is unaffected
  assert.equal((await resend(a.staff, card.id)).statusCode, 200);
});

test("resend of a voided or expired card is 409, and nothing is sent", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const { card: voided } = await issueOk(a.admin, programId);
  const { card: expired } = await issueOk(a.admin, programId);
  assert.equal((await voidCard(a.admin, voided.id)).statusCode, 200);
  await adminQuery(`UPDATE gift_cards SET expires_at = now() - interval '1 second' WHERE id = $1`, [expired.id]);
  const before = sender.messages.length;

  const v = await resend(a.admin, voided.id);
  assert.equal(v.statusCode, 409, v.body);
  const e = await resend(a.admin, expired.id);
  assert.equal(e.statusCode, 409, e.body);
  assert.equal(sender.messages.length, before);
});

// ---------- failure, backoff, timeout ----------

test("sender throws: backoff recorded, issue still 201, message with the token is not recorded", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  sender.behavior = "throw";
  sender.failure = new Error("boom");
  sender.failure.name = "SenderDownError";

  const { delivery } = await issueOk(a.admin, programId);
  assert.equal(delivery.status, "scheduled");
  assert.equal(delivery.attempts, 1);
  assert.equal(delivery.sentAt, null);

  const row = await deliveryRow(delivery.id);
  assert.equal(row.status, "scheduled");
  assert.equal(row.last_error, "SenderDownError");
  assert.equal(row.claimed_at, null);
  const [backoff] = (await adminQuery(
    `SELECT next_attempt_at BETWEEN now() + interval '1 minute 30 seconds' AND now() + interval '2 minutes 5 seconds' AS ok
       FROM gift_card_deliveries WHERE id = $1`,
    [delivery.id]
  )) as { ok: boolean }[];
  assert.equal(backoff.ok, true, "attempt 1 backs off 2 minutes");

  // Not due again yet; once due it retries with a NEW token and a longer backoff
  const dispatcher = makeDispatcher(sender, captureLog().log);
  assert.equal(await dispatcher.dispatch({}), 0);
  const firstToken = sender.lastToken();
  await makeDue(delivery.id);
  assert.equal(await dispatcher.dispatch({}), 1);
  assert.notEqual(sender.lastToken(), firstToken);
  const second = await deliveryRow(delivery.id);
  assert.equal(second.attempts, 2);
  const [backoff2] = (await adminQuery(
    `SELECT next_attempt_at BETWEEN now() + interval '3 minutes 30 seconds' AND now() + interval '4 minutes 5 seconds' AS ok
       FROM gift_card_deliveries WHERE id = $1`,
    [delivery.id]
  )) as { ok: boolean }[];
  assert.equal(backoff2.ok, true, "attempt 2 backs off 4 minutes");
});

test("a replayed issue retries a due delivery whose first send failed", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const payload = {
    programId,
    amount: 5000,
    idempotencyKey: "replay-retry-key-0001",
    recipient: { name: "Rita Recipient", email: "rita@example.com" },
    senderName: "Sam Sender",
    message: "Happy holidays",
  };
  const post = () => send(getApp(), { method: "POST", url: "/gift-cards", headers: a.admin, payload });

  sender.behavior = "throw";
  const first = await post();
  assert.equal(first.statusCode, 201, first.body);
  const { delivery } = first.json<CardWithDelivery>();
  assert.equal(delivery.status, "scheduled");
  assert.equal(sender.messages.length, 1);

  sender.behavior = "send";
  await makeDue(delivery.id);
  const replay = await post();
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.headers["idempotent-replayed"], "true");
  assert.equal(replay.json<CardWithDelivery>().delivery.status, "sent");
  assert.equal(sender.messages.length, 2, "the failed attempt and the retry");
  assert.equal((await deliveryRow(delivery.id)).status, "sent");
  assert.equal((await reveal(sender.lastToken())).statusCode, 200);
});

test("a replayed issue of an already sent card sends nothing", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const payload = {
    programId,
    amount: 5000,
    idempotencyKey: "replay-sent-key-0001",
    recipient: { name: "Rita Recipient", email: "rita@example.com" },
    senderName: "Sam Sender",
  };
  const post = () => send(getApp(), { method: "POST", url: "/gift-cards", headers: a.admin, payload });
  assert.equal((await post()).statusCode, 201);
  assert.equal(sender.messages.length, 1);

  const replay = await post();
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.headers["idempotent-replayed"], "true");
  assert.equal(replay.json<CardWithDelivery>().delivery.status, "sent");
  assert.equal(sender.messages.length, 1);
});

test("the dispatcher logs only ids, the attempt and the error name", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const { delivery } = await issueOk(a.admin, programId, { sendAt: new Date(Date.now() + 3600_000).toISOString() });
  await makeDue(delivery.id);
  const failing = new RecordingDeliverySender("throw");
  failing.onSend = (m) => {
    failing.failure = new Error(`cannot reach provider for ${m.to.email} with ${m.link}`);
    return Promise.resolve();
  };
  const { log, lines } = captureLog();
  assert.equal(await makeDispatcher(failing, log).dispatch({}), 1);

  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, "warn");
  assert.deepEqual(lines[0].obj, {
    deliveryId: delivery.id,
    tenantId: a.signup.tenantId,
    attempt: 1,
    errName: "Error",
  });
  const everything = JSON.stringify(lines);
  assert.ok(!everything.includes("rita@example.com"));
  assert.ok(!everything.includes("token="));
});

test("a sender that never settles and ignores the signal: dispatch returns after sendTimeoutMs", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const { delivery } = await issueOk(a.admin, programId, { sendAt: new Date(Date.now() + 3600_000).toISOString() });
  await makeDue(delivery.id);

  const hanging = new RecordingDeliverySender("hang");
  const started = Date.now();
  const claimed = await makeDispatcher(hanging, captureLog().log, 100).dispatch({});
  const elapsed = Date.now() - started;

  assert.equal(claimed, 1);
  assert.ok(elapsed >= 90, `waited for the timeout (${elapsed} ms)`);
  assert.ok(elapsed < 3000, `returned promptly after the timeout (${elapsed} ms)`);
  const row = await deliveryRow(delivery.id);
  assert.equal(row.status, "scheduled");
  assert.equal(row.last_error, "SendTimeout");
  assert.equal(row.attempts, 1);
});

test("sendTimeoutMs is bounded", () => {
  const db = getAppDataSource();
  const log = captureLog().log;
  for (const bad of [0, -1, 1.5, 60_001]) {
    assert.throws(
      () => new DeliveryDispatcher({ db, sender, linkBaseUrl: LINK_BASE, log, sendTimeoutMs: bad }),
      RangeError,
      String(bad)
    );
  }
  assert.doesNotThrow(() => new DeliveryDispatcher({ db, sender, linkBaseUrl: LINK_BASE, log, sendTimeoutMs: 60_000 }));
});

test("fifth failure: failed, token cleared, never claimed again", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const { delivery } = await issueOk(a.admin, programId, { sendAt: new Date(Date.now() + 3600_000).toISOString() });
  // Four attempts already failed; this claim is the fifth
  await adminQuery(
    `UPDATE gift_card_deliveries SET attempts = 4, next_attempt_at = now() - interval '1 second',
        token_hash = $2, token_expires_at = now() + interval '90 days' WHERE id = $1`,
    [delivery.id, randomBytes(32)]
  );

  const failing = new RecordingDeliverySender("throw");
  const dispatcher = makeDispatcher(failing, captureLog().log);
  assert.equal(await dispatcher.dispatch({}), 1);
  const row = await deliveryRow(delivery.id);
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 5);
  assert.equal(row.last_error, "SenderDownError");
  assert.equal(row.token_hash, null);
  assert.equal(row.token_expires_at, null);
  assert.equal(await dispatcher.dispatch({}), 0);
  assert.equal((await reveal(failing.lastToken())).statusCode, 404, "the token of a failed delivery is dead");
});

// ---------- claim, lease, concurrency ----------

test("a stale sending delivery is reclaimed with a new token; a fresh one is left alone", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const { delivery } = await issueOk(a.admin, programId, { sendAt: new Date(Date.now() + 3600_000).toISOString() });
  const oldHash = randomBytes(32);
  const sending = (claimedAgo: string) =>
    adminQuery(
      `UPDATE gift_card_deliveries SET status = 'sending', attempts = 1, claimed_at = now() - $2::interval,
          token_hash = $3, token_expires_at = now() + interval '90 days' WHERE id = $1`,
      [delivery.id, claimedAgo, oldHash]
    );

  const dispatcher = makeDispatcher(sender, captureLog().log);
  await sending("1 minute");
  assert.equal(await dispatcher.dispatch({}), 0, "inside the 10 minute lease");
  assert.equal(sender.messages.length, 0);

  await sending("11 minutes");
  assert.equal(await dispatcher.dispatch({}), 1);
  assert.equal(sender.messages.length, 1);
  const row = await deliveryRow(delivery.id);
  assert.equal(row.status, "sent");
  assert.equal(row.attempts, 2);
  assert.ok(row.token_hash && !row.token_hash.equals(oldHash), "a new token replaces the lost one");
});

test("a reclaimed sending delivery that used every attempt is failed, not sent", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const { delivery } = await issueOk(a.admin, programId, { sendAt: new Date(Date.now() + 3600_000).toISOString() });
  await adminQuery(
    `UPDATE gift_card_deliveries SET status = 'sending', attempts = 5, claimed_at = now() - interval '11 minutes',
        token_hash = $2, token_expires_at = now() + interval '90 days' WHERE id = $1`,
    [delivery.id, randomBytes(32)]
  );

  const dispatcher = makeDispatcher(sender, captureLog().log);
  assert.equal(await dispatcher.dispatch({}), 1, "claimed");
  assert.equal(sender.messages.length, 0, "nothing sent");
  const row = await deliveryRow(delivery.id);
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 5, "no further attempt is counted");
  assert.equal(row.last_error, "LeaseExpired");
  assert.equal(row.claimed_at, null);
  assert.equal(row.token_hash, null);
  assert.equal(row.token_expires_at, null);
  assert.equal(await dispatcher.dispatch({}), 0, "a failed delivery is never claimed again");
});

test("a failed send on the last allowed attempt cannot overflow the backoff", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const { delivery } = await issueOk(a.admin, programId, { sendAt: new Date(Date.now() + 3600_000).toISOString() });
  // attempts is 99 after the claim: power(2, 99) would overflow an int without the cap
  await adminQuery(`UPDATE gift_card_deliveries SET attempts = 98 WHERE id = $1`, [delivery.id]);
  await makeDue(delivery.id);
  const failing = new RecordingDeliverySender("throw");
  const dispatcher = makeDispatcher(failing, captureLog().log);
  assert.equal(await dispatcher.dispatch({ throwOnError: true }), 1);
  const row = await deliveryRow(delivery.id);
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 99);
});

test("dispatch with a deliveryId opens exactly one claim transaction", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const { delivery } = await issueOk(a.admin, programId, { sendAt: new Date(Date.now() + 3600_000).toISOString() });
  await makeDue(delivery.id);
  const db = getAppDataSource();
  const original = db.transaction.bind(db) as (...args: unknown[]) => Promise<unknown>;
  let claims = 0;
  (db as unknown as { transaction: unknown }).transaction = (...args: unknown[]) => {
    claims++;
    return original(...args);
  };
  try {
    const dispatcher = makeDispatcher(sender, captureLog().log);
    assert.equal(await dispatcher.dispatch({ deliveryId: delivery.id }), 1);
    assert.equal(claims, 1);
    assert.equal(await dispatcher.dispatch({ deliveryId: delivery.id }), 0, "nothing due: one claim, no match");
    assert.equal(claims, 2);
  } finally {
    delete (db as unknown as { transaction?: unknown }).transaction;
  }
});

test("two concurrent dispatches send each delivery once", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const { delivery } = await issueOk(a.admin, programId, {
      sendAt: new Date(Date.now() + 3600_000).toISOString(),
      recipient: { name: "Rita", email: `rita${i}@example.com` },
    });
    ids.push(delivery.id);
    await makeDue(delivery.id);
  }

  const one = makeDispatcher(sender, captureLog().log);
  const two = makeDispatcher(sender, captureLog().log);
  const [x, y] = await Promise.all([one.dispatch({}), two.dispatch({})]);
  assert.equal(x + y, 4);
  assert.equal(sender.messages.length, 4);
  assert.deepEqual(sender.messages.map((m) => m.deliveryId).sort(), [...ids].sort());
  for (const id of ids) assert.equal((await deliveryRow(id)).attempts, 1);
});

test("dispatch honours limit and an explicit deliveryId", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const { delivery } = await issueOk(a.admin, programId, { sendAt: new Date(Date.now() + 3600_000).toISOString() });
    ids.push(delivery.id);
    await makeDue(delivery.id);
  }
  const dispatcher = makeDispatcher(sender, captureLog().log);
  assert.equal(await dispatcher.dispatch({ deliveryId: ids[2] }), 1);
  assert.deepEqual(sender.messages.map((m) => m.deliveryId), [ids[2]]);
  assert.equal(await dispatcher.dispatch({ limit: 1 }), 1);
  assert.equal(await dispatcher.dispatch({}), 1);
  assert.equal(await dispatcher.dispatch({}), 0);
});

// ---------- voided and expired cards ----------

test("void with a scheduled delivery: nothing is sent, the delivery is cancelled", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const { card, delivery } = await issueOk(a.admin, programId, { sendAt: new Date(Date.now() + 3600_000).toISOString() });
  assert.equal((await voidCard(a.admin, card.id)).statusCode, 200);
  await makeDue(delivery.id);

  assert.equal(await makeDispatcher(sender, captureLog().log).dispatch({}), 0);
  assert.equal(sender.messages.length, 0);
  assert.equal((await deliveryRow(delivery.id)).status, "cancelled");
});

test("the claim cancels a pending delivery of a voided or expired card instead of sending", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const soon = () => new Date(Date.now() + 3600_000).toISOString();
  const { card: voided, delivery: dv } = await issueOk(a.admin, programId, { sendAt: soon() });
  const { card: expired, delivery: de } = await issueOk(a.admin, programId, { sendAt: soon() });
  // As if the card changed after the delivery became due, without the void having cancelled it
  await adminQuery(`UPDATE gift_cards SET status = 'voided', balance = 0 WHERE id = $1`, [voided.id]);
  await adminQuery(`UPDATE gift_cards SET expires_at = now() - interval '1 second' WHERE id = $1`, [expired.id]);
  await makeDue(dv.id);
  await makeDue(de.id);

  assert.equal(await makeDispatcher(sender, captureLog().log).dispatch({}), 2, "both were claimed");
  assert.equal(sender.messages.length, 0, "and neither was sent");
  for (const id of [dv.id, de.id]) {
    const row = await deliveryRow(id);
    assert.equal(row.status, "cancelled");
    assert.equal(row.token_hash, null);
    assert.equal(row.attempts, 0);
  }
});

test("void during sending: the outcome is a no-op, no reclaim, the link 404s", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const { card, delivery } = await issueOk(a.admin, programId, { sendAt: new Date(Date.now() + 3600_000).toISOString() });
  await makeDue(delivery.id);

  const voiding = new RecordingDeliverySender();
  voiding.onSend = async () => {
    const res = await voidCard(a.admin, card.id);
    assert.equal(res.statusCode, 200, res.body);
  };
  const { log, lines } = captureLog();
  const dispatcher = makeDispatcher(voiding, log);
  assert.equal(await dispatcher.dispatch({}), 1);

  const row = await deliveryRow(delivery.id);
  assert.equal(row.status, "cancelled", "the late success did not resurrect the delivery");
  assert.equal(row.token_hash, null);
  assert.equal(row.sent_at, null);
  assert.equal((await reveal(voiding.lastToken())).statusCode, 404);
  assert.ok(lines.some((l) => l.level === "info" && l.msg.includes("not recorded")));

  // Not reclaimable, even once the lease would have passed
  await adminQuery(`UPDATE gift_card_deliveries SET updated_at = now() - interval '1 hour' WHERE id = $1`, [delivery.id]);
  assert.equal(await dispatcher.dispatch({}), 0);
  assert.equal(voiding.messages.length, 1);
});

test("resend during sending: the late outcome of the old send does not touch the new delivery state", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const { card, delivery } = await issueOk(a.admin, programId, { sendAt: new Date(Date.now() + 3600_000).toISOString() });
  await makeDue(delivery.id);

  // The first send is in flight (delivery `sending`) when the resend replaces the token and sends
  // through the app's own dispatcher and sender
  const slow = new RecordingDeliverySender();
  slow.onSend = async () => {
    const res = await resend(a.admin, card.id);
    assert.equal(res.statusCode, 200, res.body);
  };
  assert.equal(await makeDispatcher(slow, captureLog().log).dispatch({}), 1);

  assert.equal(slow.messages.length, 1);
  assert.equal(sender.messages.length, 1);
  const first = slow.lastToken();
  const second = sender.lastToken();
  assert.notEqual(first, second);
  assert.equal((await reveal(first)).statusCode, 404, "the replaced token is dead");
  assert.equal((await reveal(second)).statusCode, 200);
  const row = await deliveryRow(delivery.id);
  assert.equal(row.status, "sent", "the old send's late success did not overwrite the resend's state");
  assert.equal(row.attempts, 1);
});

test("resend and void concurrently: no deadlock; voided and cancelled", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  // Scheduled for later, so the delivery is `scheduled` whichever request wins: resend keeps the
  // send date and sends nothing, and void cancels it. (Issued for now, it would be `sent` and void
  // would rightly keep `sent`, making the outcome depend on the order.)
  const { card, delivery } = await issueOk(a.admin, programId, { sendAt: new Date(Date.now() + 3600_000).toISOString() });

  const [r, v] = await Promise.all([resend(a.admin, card.id), voidCard(a.admin, card.id)]);
  assert.ok(r.statusCode === 200 || r.statusCode === 409, `resend: ${r.statusCode} ${r.body}`);
  assert.equal(v.statusCode, 200, v.body);

  const row = await deliveryRow(delivery.id);
  assert.equal(row.status, "cancelled");
  assert.equal(row.token_hash, null);
  const [c] = (await adminQuery(`SELECT status FROM gift_cards WHERE id = $1`, [card.id])) as { status: string }[];
  assert.equal(c.status, "voided");
  assert.equal(sender.messages.length, 0, "nothing was due, so nothing was sent");
});

test("a voided card's link 404s", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const { card } = await issueOk(a.admin, programId);
  const token = sender.lastToken();
  assert.equal((await reveal(token)).statusCode, 200);
  assert.equal((await voidCard(a.admin, card.id)).statusCode, 200);
  const res = await reveal(token);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: "Link is invalid or has expired" });
});

test("void of a sent card keeps the delivery `sent`, clears the token, and the link stops working", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const { card, delivery } = await issueOk(a.admin, programId);
  const token = sender.lastToken();
  const before = await deliveryRow(delivery.id);
  assert.equal(before.status, "sent");
  assert.ok(before.token_hash);

  assert.equal((await voidCard(a.admin, card.id)).statusCode, 200);

  const row = await deliveryRow(delivery.id);
  assert.equal(row.status, "sent");
  assert.deepEqual(row.sent_at, before.sent_at);
  assert.equal(row.token_hash, null);
  assert.equal(row.token_expires_at, null);
  assert.equal(row.claimed_at, null);
  const res = await reveal(token);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: "Link is invalid or has expired" });

  const got = await send(getApp(), { method: "GET", url: `/gift-cards/${card.id}`, headers: a.admin });
  assert.equal(got.statusCode, 200, got.body);
  assert.equal(got.json<CardWithDelivery & { card: { status: string } }>().delivery.status, "sent");
  assert.equal(got.json<{ card: { status: string } }>().card.status, "voided");
});

// ---------- resend keeps the scheduled send date ----------

test("resend of a delivery scheduled for later keeps send_at: still scheduled, nothing sent", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const sendAt = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();
  const { card, delivery } = await issueOk(a.admin, programId, { sendAt });
  assert.equal(delivery.status, "scheduled");

  const nextAttemptIsSendAt = async () => {
    const [row] = (await adminQuery(
      `SELECT next_attempt_at = send_at AS same, send_at FROM gift_card_deliveries WHERE id = $1`,
      [delivery.id]
    )) as { same: boolean; send_at: Date }[];
    assert.equal(row.same, true, "next_attempt_at is the scheduled send date");
    assert.equal(row.send_at.toISOString(), sendAt);
  };

  // Same recipient
  const same = await resend(a.admin, card.id);
  assert.equal(same.statusCode, 200, same.body);
  assert.equal(same.json<{ delivery: DeliveryDto }>().delivery.status, "scheduled");
  await nextAttemptIsSendAt();

  // Admin changes the recipient
  const changed = await resend(a.admin, card.id, { recipient: { email: "other@example.com" } });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json<{ delivery: DeliveryDto }>().delivery.status, "scheduled");
  await nextAttemptIsSendAt();
  assert.equal((await deliveryRow(delivery.id)).recipient_email, "other@example.com");

  assert.equal(sender.messages.length, 0, "the sender was never called");
});

test("resend of a sent delivery whose send date has passed sends immediately", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const { card, delivery } = await issueOk(a.admin, programId, { sendAt: new Date(Date.now() + 3600_000).toISOString() });
  await makeDue(delivery.id);
  assert.equal(await makeDispatcher(sender, captureLog().log).dispatch({}), 1);
  assert.equal(sender.messages.length, 1);

  const res = await resend(a.admin, card.id);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json<{ delivery: DeliveryDto }>().delivery.status, "sent");
  assert.equal(sender.messages.length, 2);
});

// ---------- dispatch script path ----------

test("dispatchAllDue: a sender failure is recorded for retry and does not reject", async () => {
  const a = await setupTenant("acme", "ada@acme.example");
  const programId = await createProgram(a.admin);
  const { delivery } = await issueOk(a.admin, programId, { sendAt: new Date(Date.now() + 3600_000).toISOString() });
  await makeDue(delivery.id);

  const failing = new RecordingDeliverySender("throw");
  assert.equal(await dispatchAllDue(makeDispatcher(failing, captureLog().log)), 1);
  const row = await deliveryRow(delivery.id);
  assert.equal(row.status, "scheduled");
  assert.equal(row.attempts, 1);
  assert.equal(row.last_error, "SenderDownError");
});
