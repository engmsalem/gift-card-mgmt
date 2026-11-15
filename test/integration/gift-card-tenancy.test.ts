import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { adminQuery, createGiftCardProgram, issueGiftCard, send, setupTenantActors, useTestApp } from "./helpers";

const getApp = useTestApp();

const CARD_AUTH_FAILED = "Invalid card number or PIN";
const newKey = () => randomBytes(12).toString("hex");

// Every gift card table, row by row. Equal snapshots mean nothing was created, changed or deleted.
async function snapshot(): Promise<string> {
  const tables = [
    "gift_card_programs",
    "gift_cards",
    "gift_card_transactions",
    "gift_card_deliveries",
    "audit_logs",
  ];
  const parts: unknown[] = [];
  for (const table of tables) {
    parts.push(await adminQuery(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY t.id`));
  }
  return JSON.stringify(parts);
}

test("another tenant's programs, cards, ledgers and transactions are 404 and nothing changes", async () => {
  const app = getApp();
  const a = await setupTenantActors(app, "acme", "ada@acme.example");
  const b = await setupTenantActors(app, "globex", "bob@globex.example");

  const programA = await createGiftCardProgram(app, a.admin);
  const cardA = await issueGiftCard(app, a.admin, a.signup.tenantId, programA, 10000);
  assert.ok(cardA.pin, "the fixture program requires a PIN");
  // B has a program of its own, so lookup and redeem reach the card search, not a missing-program path
  await createGiftCardProgram(app, b.admin);

  // A redeems once, so there is a transaction for B to refund
  const redeemed = await send(app, {
    method: "POST",
    url: "/gift-cards/redeem",
    headers: a.staff,
    payload: { cardNumber: cardA.number, pin: cardA.pin, amount: 1000, idempotencyKey: newKey() },
  });
  assert.equal(redeemed.statusCode, 201, redeemed.body);
  const transactionA = redeemed.json<{ transaction: { id: string } }>().transaction.id;

  const read = await send(app, { method: "GET", url: `/gift-cards/${cardA.id}`, headers: a.admin });
  assert.equal(read.statusCode, 200, read.body);
  const reference = read.json<{ card: { referenceNumber: string } }>().card.referenceNumber;

  const before = await snapshot();

  const notFound: { method: "GET" | "POST" | "PATCH"; url: string; payload?: object; as: "admin" | "staff" }[] = [
    { method: "GET", url: `/gift-card-programs/${programA}`, as: "admin" },
    { method: "GET", url: `/gift-card-programs/${programA}`, as: "staff" },
    { method: "PATCH", url: `/gift-card-programs/${programA}`, payload: { maxValue: 5 }, as: "admin" },
    {
      method: "POST",
      url: "/gift-cards",
      payload: {
        programId: programA,
        amount: 500,
        idempotencyKey: newKey(),
        recipient: { name: "Rita Recipient", email: "rita@example.com" },
        senderName: "Bob",
      },
      as: "admin",
    },
    { method: "GET", url: `/gift-cards/${cardA.id}`, as: "admin" },
    { method: "GET", url: `/gift-cards/${cardA.id}`, as: "staff" },
    { method: "GET", url: `/gift-cards/by-reference/${reference}`, as: "admin" },
    { method: "GET", url: `/gift-cards/${cardA.id}/transactions`, as: "admin" },
    { method: "POST", url: `/gift-card-transactions/${transactionA}/refunds`, payload: { amount: 500, idempotencyKey: newKey() }, as: "admin" },
    { method: "POST", url: `/gift-cards/${cardA.id}/resend`, as: "admin" },
    { method: "POST", url: `/gift-cards/${cardA.id}/resend`, as: "staff" },
    {
      method: "POST",
      url: `/gift-cards/${cardA.id}/resend`,
      payload: { recipient: { email: "attacker@example.com" } },
      as: "admin",
    },
    { method: "POST", url: `/gift-cards/${cardA.id}/suspend`, as: "admin" },
    { method: "POST", url: `/gift-cards/${cardA.id}/resume`, as: "admin" },
    { method: "POST", url: `/gift-cards/${cardA.id}/void`, as: "admin" },
    { method: "POST", url: `/gift-cards/${cardA.id}/unlock`, as: "admin" },
  ];
  for (const request of notFound) {
    const res = await send(app, {
      method: request.method,
      url: request.url,
      headers: b[request.as],
      payload: request.payload,
    });
    assert.equal(res.statusCode, 404, `${request.method} ${request.url} as ${request.as} -> ${res.statusCode} ${res.body}`);
  }

  // A's number is another tenant's: lookup and redeem answer the generic card error, with and
  // without the right PIN, and five wrong PINs would lock nothing
  for (const pin of [cardA.pin, "000000", undefined, "000000", "000000", "000000", "000000"]) {
    const body = { cardNumber: cardA.number, ...(pin === undefined ? {} : { pin }) };
    const lookedUp = await send(app, { method: "POST", url: "/gift-cards/lookup", headers: b.admin, payload: body });
    assert.equal(lookedUp.statusCode, 404, lookedUp.body);
    assert.deepEqual(lookedUp.json(), { error: CARD_AUTH_FAILED });
    const redeemedByB = await send(app, {
      method: "POST",
      url: "/gift-cards/redeem",
      headers: b.staff,
      payload: { ...body, amount: 100, idempotencyKey: newKey() },
    });
    assert.equal(redeemedByB.statusCode, 404, redeemedByB.body);
    assert.deepEqual(redeemedByB.json(), { error: CARD_AUTH_FAILED });
  }

  // B's program list does not include A's program
  const listed = await send(app, { method: "GET", url: "/gift-card-programs", headers: b.admin });
  assert.equal(listed.statusCode, 200);
  assert.ok(!listed.json<{ id: string }[]>().some((p) => p.id === programA));

  assert.equal(await snapshot(), before, "no gift card table changed");
  const [{ failed_pin_attempts }] = (await adminQuery(`SELECT failed_pin_attempts FROM gift_cards WHERE id = $1`, [
    cardA.id,
  ])) as { failed_pin_attempts: number }[];
  assert.equal(failed_pin_attempts, 0);

  // The control: A can still do all of it, so the 404s above are about the tenant
  const lookedUpByA = await send(app, {
    method: "POST",
    url: "/gift-cards/lookup",
    headers: a.admin,
    payload: { cardNumber: cardA.number, pin: cardA.pin },
  });
  assert.equal(lookedUpByA.statusCode, 200, lookedUpByA.body);
});
