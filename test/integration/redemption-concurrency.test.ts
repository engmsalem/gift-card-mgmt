import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { requestHashRedeem } from "../../src/gift-cards/request-hash";
import {
  adminQuery,
  buildTestApp,
  createGiftCardProgram,
  issueGiftCard,
  loadTestConfig,
  send,
  setupTenantActors,
  useTestApp,
} from "./helpers";
import { openAdminTransaction, waitUntilBlocked } from "../support/lock-staging";
import { CardCrypto } from "../../src/gift-cards/card-crypto";

// Waits behind a held row lock can last a while on a busy machine; only the 503 test shortens this
const getApp = useTestApp(() => ({ lockTimeoutMs: 30_000 }));

type Headers = { authorization: string };
type Card = { id: string; number: string; pin: string | null };

const newKey = () => randomBytes(12).toString("hex");

function redeem(headers: Headers, card: Card, amount: number, overrides: Record<string, unknown> = {}, app = getApp()) {
  return send(app, {
    method: "POST",
    url: "/gift-cards/redeem",
    headers,
    payload: {
      cardNumber: card.number,
      ...(card.pin === null ? {} : { pin: card.pin }),
      amount,
      idempotencyKey: newKey(),
      ...overrides,
    },
  });
}

async function setup(amount: number) {
  const actors = await setupTenantActors(getApp(), "acme", "ada@acme.com");
  const programId = await createGiftCardProgram(getApp(), actors.admin);
  const card = await issueGiftCard(getApp(), actors.admin, actors.signup.tenantId, programId, amount);
  return { actors, programId, card };
}

async function cardRow(cardId: string) {
  const [row] = (await adminQuery(
    `SELECT balance, status, failed_pin_attempts, pin_locked_until FROM gift_cards WHERE id = $1`,
    [cardId]
  )) as { balance: number; status: string; failed_pin_attempts: number; pin_locked_until: Date | null }[];
  return row;
}

async function ledgerCount(cardId: string, type: string): Promise<number> {
  const [row] = (await adminQuery(
    `SELECT count(*)::int AS n FROM gift_card_transactions WHERE gift_card_id = $1 AND type = $2`,
    [cardId, type]
  )) as { n: number }[];
  return row.n;
}

function statuses(responses: LightMyRequestResponse[]): number[] {
  return responses.map((r) => r.statusCode).sort();
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

test("double spend: 10 concurrent 30-unit redeems on 100 -> exactly 3 succeed, balance 10, 3 rows", async () => {
  const { actors, card } = await setup(100);
  const responses = await Promise.all(Array.from({ length: 10 }, () => redeem(actors.staff, card, 30)));

  assert.deepEqual(statuses(responses), [201, 201, 201, 409, 409, 409, 409, 409, 409, 409]);
  for (const res of responses.filter((r) => r.statusCode === 409)) {
    assert.deepEqual(res.json(), { error: "Insufficient balance" });
  }
  assert.equal((await cardRow(card.id)).balance, 10);
  assert.equal(await ledgerCount(card.id, "redeem"), 3);
  const balances = responses
    .filter((r) => r.statusCode === 201)
    .map((r) => r.json<{ transaction: { balanceAfter: number } }>().transaction.balanceAfter)
    .sort((a, b) => b - a);
  assert.deepEqual(balances, [70, 40, 10], "each success saw the balance the previous one left");
});

test("10 concurrent same-key redeems -> one ledger row, the same transaction id", async () => {
  const { actors, card } = await setup(1000);
  const key = newKey();
  const responses = await Promise.all(Array.from({ length: 10 }, () => redeem(actors.staff, card, 100, { idempotencyKey: key })));

  assert.deepEqual(statuses(responses), [200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
  const ids = new Set(responses.map((r) => r.json<{ transaction: { id: string } }>().transaction.id));
  assert.equal(ids.size, 1);
  for (const res of responses.filter((r) => r.statusCode === 200)) {
    assert.equal(res.headers["idempotent-replayed"], "true");
  }
  assert.equal(await ledgerCount(card.id, "redeem"), 1);
  assert.equal((await cardRow(card.id)).balance, 900);
});

test("redeem: the same key used concurrently on another card -> 409, the second card unchanged (staged)", async () => {
  const { actors, programId, card: cardY } = await setup(1000);
  const cardX = await issueGiftCard(getApp(), actors.admin, actors.signup.tenantId, programId, 500);
  const key = newKey();

  // Another request redeems card X with this key and has not committed yet
  const tx = await openAdminTransaction();
  try {
    await tx.query(
      `INSERT INTO gift_card_transactions (tenant_id, gift_card_id, currency, type, amount, balance_after,
          idempotency_key, request_hash, actor_user_id)
       VALUES ($1, $2, 'CAD', 'redeem', 100, 400, $3, $4, $5)`,
      [actors.signup.tenantId, cardX.id, key, randomBytes(32), actors.staffId]
    );
    await tx.query(`UPDATE gift_cards SET balance = 400 WHERE id = $1`, [cardX.id]);

    // Card Y does not see the uncommitted row, so the request runs to its ledger insert and blocks there
    const pending = redeem(actors.staff, cardY, 100, { idempotencyKey: key });
    await waitUntilBlocked(adminQuery, 1);
    await tx.commit();

    const res = await pending;
    assert.equal(res.statusCode, 409, res.body);
    assert.deepEqual(res.json(), { error: "Idempotency key already used with a different request" });
  } finally {
    await tx.rollback();
  }
  const y = await cardRow(cardY.id);
  assert.equal(y.balance, 1000, "the rolled-back redeem left card Y alone");
  assert.equal(await ledgerCount(cardY.id, "redeem"), 0);
  assert.equal(await ledgerCount(cardX.id, "redeem"), 1);
});

test("redeem: a concurrent winner with the same request hash is replayed after rollback (staged)", async () => {
  // The committed row has the hash of this very request, as if another instance had just served it
  const { actors, card } = await setup(1000);
  const config = loadTestConfig();
  const crypto = new CardCrypto({ encryption: config.cardEncryptionKey, lookup: config.cardLookupKey });
  const key = newKey();
  const hash = requestHashRedeem({ hmac: crypto.lookupHash(card.number), amount: 100 });

  // The winner inserts only the ledger row (not touching the card), so this request locks the card
  // itself, finds no committed row, and blocks on the unique key
  const tx = await openAdminTransaction();
  try {
    await tx.query(
      `INSERT INTO gift_card_transactions (tenant_id, gift_card_id, currency, type, amount, balance_after,
          idempotency_key, request_hash, actor_user_id)
       VALUES ($1, $2, 'CAD', 'redeem', 100, 900, $3, $4, $5)`,
      [actors.signup.tenantId, card.id, key, hash, actors.staffId]
    );
    const pending = redeem(actors.staff, card, 100, { idempotencyKey: key });
    await waitUntilBlocked(adminQuery, 1);
    await tx.commit();

    const res = await pending;
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers["idempotent-replayed"], "true");
    assert.equal(res.json<{ transaction: { balanceAfter: number } }>().transaction.balanceAfter, 900);
  } finally {
    await tx.rollback();
  }
  assert.equal(await ledgerCount(card.id, "redeem"), 1);
  assert.equal((await cardRow(card.id)).balance, 1000, "the replayed request did not debit again");
  // The fixture row stood in for a real redeem; settle the balance so the ledger invariant holds
  await adminQuery(`UPDATE gift_cards SET balance = 900 WHERE id = $1`, [card.id]);
});

test("PIN attempts are serialized: 6 queued wrong PINs lock the card exactly once, then the correct PIN fails (staged)", async () => {
  const { actors, card } = await setup(1000);
  const wrong = card.pin === "123456" ? "654321" : "123456";

  const tx = await openAdminTransaction();
  try {
    await tx.query(`SELECT id FROM gift_cards WHERE id = $1 FOR UPDATE`, [card.id]);
    // All six wait on the card lock. PostgreSQL doesn't promise to grant a row lock in arrival
    // order once a waiter has updated the row, so the requests are identical and the assertions
    // hold in any order: without serialization, attempts would be lost and the card never locks.
    const pending: Promise<LightMyRequestResponse>[] = [];
    for (let i = 1; i <= 6; i++) {
      pending.push(redeem(actors.staff, card, 100, { pin: wrong }));
      await waitUntilBlocked(adminQuery, i);
    }
    await tx.commit();

    const responses = await Promise.all(pending);
    for (const res of responses) {
      assert.equal(res.statusCode, 404, res.body);
      assert.deepEqual(res.json(), { error: "Invalid card number or PIN" });
    }
  } finally {
    await tx.rollback();
  }
  const locked = await redeem(actors.staff, card, 100);
  assert.equal(locked.statusCode, 404, "the correct PIN is refused while the card is locked");
  assert.deepEqual(locked.json(), { error: "Invalid card number or PIN" });
  const row = await cardRow(card.id);
  assert.equal(row.balance, 1000);
  assert.equal(row.failed_pin_attempts, 0);
  assert.ok(row.pin_locked_until && row.pin_locked_until.getTime() > Date.now());
  assert.equal(await ledgerCount(card.id, "redeem"), 0);
  const audit = (await adminQuery(`SELECT user_id FROM audit_logs WHERE action = 'gift_card.pin_locked'`)) as {
    user_id: string;
  }[];
  assert.equal(audit.length, 1);
});

test("concurrent refunds cannot exceed the redemption", async () => {
  const { actors, card } = await setup(1000);
  const redeemed = await redeem(actors.staff, card, 600);
  assert.equal(redeemed.statusCode, 201, redeemed.body);
  const transactionId = redeemed.json<{ transaction: { id: string } }>().transaction.id;

  const responses = await Promise.all(
    Array.from({ length: 4 }, () =>
      send(getApp(), {
        method: "POST",
        url: `/gift-card-transactions/${transactionId}/refunds`,
        headers: actors.admin,
        payload: { amount: 250, idempotencyKey: newKey() },
      })
    )
  );
  assert.deepEqual(statuses(responses), [201, 201, 409, 409]);
  assert.equal((await cardRow(card.id)).balance, 900);
  assert.equal(await ledgerCount(card.id, "refund"), 2);
});

test("lock_timeout: a request that cannot get the card lock answers 503 with Retry-After", async () => {
  const { actors, card } = await setup(1000);
  const app = await buildTestApp(undefined, { lockTimeoutMs: 200 });
  const tx = await openAdminTransaction();
  try {
    await tx.query(`SELECT id FROM gift_cards WHERE id = $1 FOR UPDATE`, [card.id]);
    const res = await redeem(actors.staff, card, 100, {}, app);
    assert.equal(res.statusCode, 503, res.body);
    assert.equal(res.headers["retry-after"], "1");
    assert.deepEqual(res.json(), { error: "Temporary conflict, please retry" });
  } finally {
    await tx.rollback();
    await app.close();
  }
  assert.equal((await cardRow(card.id)).balance, 1000);
  assert.equal(await ledgerCount(card.id, "redeem"), 0);
  // Once the lock is gone the same request works
  assert.equal((await redeem(actors.staff, card, 100)).statusCode, 201);
});
