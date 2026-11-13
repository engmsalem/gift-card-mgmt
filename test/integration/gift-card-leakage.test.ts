import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApp } from "../../src/app";
import {
  PASSWORD,
  adminQuery,
  createGiftCardProgram,
  getAppDataSource,
  issueGiftCard,
  loadTestConfig,
  resetDb,
  send,
  setupDatabase,
  setupTenantActors,
  teardownDatabase,
} from "./helpers";
import { RecordingDeliverySender, tokenOf } from "../support/recording-delivery-sender";

before(setupDatabase);
after(teardownDatabase);

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

const MARKER_EMAIL = "leak.marker.7f3a@example.com";
const newKey = () => randomBytes(12).toString("hex");

interface Recorded {
  label: string;
  status: number;
  body: string;
  // The reveal endpoint is the one response that carries the number and PIN, by design
  mayCarryCardSecrets: boolean;
}

// A digit string is only a match when it is not part of a longer run of digits (a PIN is six digits
// and would otherwise match inside timestamps and process ids)
function containsDigits(text: string, digits: string): boolean {
  return new RegExp(`(?<![0-9])${digits}(?![0-9])`).test(text);
}

function numberVariants(number: string): string[] {
  const groups = number.match(/.{1,4}/g) ?? [number];
  return [number, groups.join(" "), groups.join("-")];
}

interface CardSecretsRow {
  card_number_enc: Buffer;
  pin_enc: Buffer | null;
}

async function secretsRow(cardId: string): Promise<CardSecretsRow> {
  const [row] = (await adminQuery(`SELECT card_number_enc, pin_enc FROM gift_cards WHERE id = $1`, [
    cardId,
  ])) as CardSecretsRow[];
  return row;
}

test("no log line or non-reveal response carries a card number, PIN, token, link, recipient email or ciphertext", async () => {
  await resetDb();

  const logLines: string[] = [];
  const sender = new RecordingDeliverySender();
  const app: FastifyInstance = await buildApp({
    config: loadTestConfig(),
    dataSource: getAppDataSource(),
    logger: { level: "trace", stream: { write: (line: string) => void logLines.push(line) } },
    giftCards: { deliverySender: sender },
  });

  try {
    // A route that fails inside the database with the marker email as a bound parameter and in the
    // failing row, as a real insert bug would. Added before the app is ready.
    app.post("/__leakage/db-error", async () =>
      app.db.query(
        `INSERT INTO gift_card_deliveries
           (tenant_id, gift_card_id, recipient_name, recipient_email, sender_name, send_at, status, next_attempt_at, created_by)
         VALUES ($1, $2, 'Marker', $3, 'Marker', now(), 'bogus', now(), $4)`,
        [randomUUID(), randomUUID(), MARKER_EMAIL, randomUUID()]
      )
    );

    // The redaction backstop: a handler that logs the whole database error, as the error handler used to
    app.post("/__leakage/db-error-logged-whole", async (request, reply) => {
      try {
        await app.db.query(`INSERT INTO gift_card_deliveries (recipient_email) VALUES ($1)`, [MARKER_EMAIL]);
      } catch (err) {
        request.log.error({ err }, "logged whole");
      }
      return reply.status(204).send();
    });

    const recorded: Recorded[] = [];
    const call = async (label: string, opts: InjectOptions, mayCarryCardSecrets = false) => {
      const res = await send(app, opts);
      recorded.push({ label, status: res.statusCode, body: res.body, mayCarryCardSecrets });
      return res;
    };

    const actors = await setupTenantActors(app, "acme", "ada@acme.com");
    const tenantId = actors.signup.tenantId;
    const programId = await createGiftCardProgram(app, actors.admin);

    // 1 + 2. Issue; the delivery is dispatched on issue
    const card = await issueGiftCard(app, actors.admin, tenantId, programId, 10000);
    assert.ok(card.pin);
    assert.equal(sender.messages.length, 1);
    const issueAgain = await call("get card", { method: "GET", url: `/gift-cards/${card.id}`, headers: actors.admin });
    assert.equal(issueAgain.statusCode, 200, issueAgain.body);

    // 3. Reveal: the one response that carries the number and PIN
    const revealed = await call(
      "reveal",
      { method: "POST", url: "/gift-card-links/reveal", payload: { token: sender.lastToken() } },
      true
    );
    assert.equal(revealed.statusCode, 200, revealed.body);
    assert.equal(revealed.json<{ cardNumber: string }>().cardNumber, card.number, "the reveal does carry the number");

    // 4. Lookup, 5. wrong PIN, 6. redeem
    const wrongPin = card.pin === "123456" ? "654321" : "123456";
    const looked = await call("lookup", {
      method: "POST",
      url: "/gift-cards/lookup",
      headers: actors.staff,
      payload: { cardNumber: card.number, pin: card.pin },
    });
    assert.equal(looked.statusCode, 200, looked.body);
    const wrong = await call("lookup wrong pin", {
      method: "POST",
      url: "/gift-cards/lookup",
      headers: actors.staff,
      payload: { cardNumber: card.number, pin: wrongPin },
    });
    assert.equal(wrong.statusCode, 404, wrong.body);
    const wrongRedeem = await call("redeem wrong pin", {
      method: "POST",
      url: "/gift-cards/redeem",
      headers: actors.staff,
      payload: { cardNumber: card.number, pin: wrongPin, amount: 100, idempotencyKey: newKey() },
    });
    assert.equal(wrongRedeem.statusCode, 404, wrongRedeem.body);
    const redeemed = await call("redeem", {
      method: "POST",
      url: "/gift-cards/redeem",
      headers: actors.staff,
      payload: { cardNumber: card.number, pin: card.pin, amount: 1500, idempotencyKey: newKey() },
    });
    assert.equal(redeemed.statusCode, 201, redeemed.body);

    // 7. Resend replaces the token
    const resent = await call("resend", { method: "POST", url: `/gift-cards/${card.id}/resend`, headers: actors.admin });
    assert.equal(resent.statusCode, 200, resent.body);
    assert.equal(sender.messages.length, 2);

    // 10. A real CardCryptoError: a second card whose stored number is corrupted, then revealed
    const card2 = await issueGiftCard(app, actors.admin, tenantId, programId, 2000);
    assert.equal(sender.messages.length, 3);
    const token2 = sender.lastToken();
    const intact2 = await secretsRow(card2.id);
    await adminQuery(
      `UPDATE gift_cards SET card_number_enc = set_byte(card_number_enc, 20, get_byte(card_number_enc, 20) # 255) WHERE id = $1`,
      [card2.id]
    );
    const broken = await call("reveal corrupted", {
      method: "POST",
      url: "/gift-card-links/reveal",
      payload: { token: token2 },
    });
    assert.equal(broken.statusCode, 500, broken.body);
    assert.deepEqual(broken.json(), { error: "Internal Server Error" });

    // 8. A sender that throws with the token in its message
    sender.behavior = "throw";
    sender.onSend = (message) => {
      sender.failure = new Error(`smtp rejected ${message.link} (token ${tokenOf(message.link)}) for ${message.to.email}`);
      return Promise.resolve();
    };
    const failedResend = await call("resend, sender throws", {
      method: "POST",
      url: `/gift-cards/${card.id}/resend`,
      headers: actors.admin,
    });
    assert.equal(failedResend.statusCode, 200, failedResend.body);
    assert.equal(sender.messages.length, 4);

    // 9. A real database error carrying the marker email
    const dbError = await call("database error", { method: "POST", url: "/__leakage/db-error" });
    assert.equal(dbError.statusCode, 500, dbError.body);
    assert.deepEqual(dbError.json(), { error: "Internal Server Error" });

    const loggedWhole = await call("database error logged whole", { method: "POST", url: "/__leakage/db-error-logged-whole" });
    assert.equal(loggedWhole.statusCode, 204);

    // ---- assertions ----
    const rawLogs = logLines.join("");
    const parsed = logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(parsed.length > 20, "the log capture is not empty");

    // The log lines these assertions are about exist (so a silent logger cannot pass)
    const dbLine = parsed.find((l) => l.msg === "request failed" && (l.err as { code?: string }).code === "23514");
    assert.ok(dbLine, "the database error was logged");
    assert.deepEqual(dbLine.err, {
      name: "QueryFailedError",
      code: "23514",
      constraint: "gift_card_deliveries_status_check",
      table: "gift_card_deliveries",
    });
    const wholeLine = parsed.find((l) => l.msg === "logged whole");
    assert.ok(wholeLine, "the whole error was logged");
    assert.equal((wholeLine.err as { code?: string }).code, "23502", "it is a real database error");
    const cryptoLine = parsed.find((l) => l.msg === "card decryption failed");
    assert.ok(cryptoLine, "the CardCryptoError was logged");
    assert.equal(cryptoLine.cardId, card2.id);
    assert.ok(
      parsed.some((l) => l.outcome === "card_auth_failed" && l.userId === actors.staffId),
      "the failed card authentication was logged with the actor"
    );
    assert.ok(parsed.some((l) => l.errName === "Error"), "the failed send was logged by name only");

    const row1 = await secretsRow(card.id);
    const tokens = sender.messages.map((m) => tokenOf(m.link));
    assert.equal(new Set(tokens).size, tokens.length);
    const links = sender.messages.map((m) => m.link);
    const ciphertexts = [row1.card_number_enc, row1.pin_enc, intact2.card_number_enc, intact2.pin_enc].filter(
      (b): b is Buffer => b !== null
    );
    const ciphertextForms = ciphertexts.flatMap((b) => [b.toString("hex"), b.toString("base64"), b.toString("base64url")]);

    const numbers = [card, card2].flatMap((c) => numberVariants(c.number));
    const pins = [card.pin, card2.pin].filter((p): p is string => p !== null);

    const forbiddenEverywhereExceptReveal = [...numbers, ...tokens, ...links, ...ciphertextForms];
    const forbiddenInLogsOnly = [MARKER_EMAIL, "rita@example.com", PASSWORD, "#token="];

    for (const needle of [...forbiddenEverywhereExceptReveal, ...forbiddenInLogsOnly]) {
      assert.ok(!rawLogs.includes(needle), `a log line contains ${needle.slice(0, 8)}... (${needle.length} chars)`);
    }
    for (const pin of pins) {
      assert.ok(!containsDigits(rawLogs, pin), "a log line contains a PIN");
    }

    for (const r of recorded) {
      for (const needle of [...tokens, ...links, ...ciphertextForms, MARKER_EMAIL]) {
        assert.ok(!r.body.includes(needle), `response "${r.label}" contains ${needle.slice(0, 8)}...`);
      }
      if (r.mayCarryCardSecrets) continue;
      for (const needle of numbers) assert.ok(!r.body.includes(needle), `response "${r.label}" contains a card number`);
      for (const pin of pins) assert.ok(!containsDigits(r.body, pin), `response "${r.label}" contains a PIN`);
    }

    // At rest: the number is ciphertext, and the PIN is not stored in the clear in any column
    assert.ok(!row1.card_number_enc.includes(Buffer.from(card.number, "utf8")));
    assert.ok(row1.pin_enc && !row1.pin_enc.includes(Buffer.from(card.pin, "utf8")));
    const [{ stored }] = (await adminQuery(`SELECT to_jsonb(c)::text AS stored FROM gift_cards c WHERE id = $1`, [
      card.id,
    ])) as { stored: string }[];
    assert.ok(!containsDigits(stored.replace(/[a-f]/g, "x"), card.pin), "the PIN is in no gift_cards column");
    for (const n of numberVariants(card.number)) assert.ok(!stored.includes(n), "the number is in no gift_cards column");

    // Card responses have exactly the card-schema keys
    const cardBodies: [string, object][] = [
      ["get card", issueAgain.json<{ card: object }>().card],
      ["lookup", looked.json<{ card: object }>().card],
      ["redeem", redeemed.json<{ card: object }>().card],
    ];
    for (const [label, body] of cardBodies) {
      assert.deepEqual(Object.keys(body).sort(), CARD_KEYS, `${label} card keys`);
    }
  } finally {
    await app.close();
  }
});
