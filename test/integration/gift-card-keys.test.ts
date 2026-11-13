import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { CardCrypto } from "../../src/gift-cards/card-crypto";
import { adminQuery, buildTestApp, loadTestConfig, resetDb, setupDatabase, teardownDatabase } from "./helpers";
import { openAdminTransaction, waitUntilBlocked } from "../support/lock-staging";

// Other valid keys (64 hex, many distinct bytes). Distinct from the fixed test keys.
const OTHER_ENCRYPTION_KEY = createHash("sha256").update("keys-test-other-encryption").digest("hex");
const OTHER_LOOKUP_KEY = createHash("sha256").update("keys-test-other-lookup").digest("hex");

interface CheckRow {
  purpose: string;
  key_id: number;
  check_value: Buffer;
}

async function checkRows(): Promise<CheckRow[]> {
  return (await adminQuery(
    `SELECT purpose, key_id, check_value FROM gift_card_key_checks ORDER BY purpose, key_id`
  )) as CheckRow[];
}

/** The check values that the keys of `config` should record. */
function expectedChecks(config: ReturnType<typeof loadTestConfig>) {
  return new CardCrypto({ encryption: config.cardEncryptionKey, lookup: config.cardLookupKey }).keyCheckValues();
}

/** Inserts the fixture chain down to a card that uses the given key ids (as the owner role). */
async function insertCardUsingKeys(encryptionKeyId: number, lookupKeyId: number): Promise<void> {
  const [tenant] = (await adminQuery(
    `INSERT INTO tenants (name, subdomain) VALUES ('Keys', 'keys-test') RETURNING id`
  )) as { id: string }[];
  const [user] = (await adminQuery(
    `INSERT INTO users (tenant_id, name, email, password_hash) VALUES ($1, 'U', 'keys@test.example', 'x') RETURNING id`,
    [tenant.id]
  )) as { id: string }[];
  const [program] = (await adminQuery(
    `INSERT INTO gift_card_programs (tenant_id, name, card_type, currency, country, card_number_prefix,
        card_number_length, pin_required, max_value)
     VALUES ($1, 'P', 'paid', 'CAD', 'CA', '7000', 19, false, 100000) RETURNING id`,
    [tenant.id]
  )) as { id: string }[];
  await adminQuery(
    `INSERT INTO gift_cards (tenant_id, program_id, currency, reference_number, card_number_enc,
        card_number_hmac, card_number_last4, encryption_key_id, lookup_key_id, initial_amount, balance,
        status, issued_by)
     VALUES ($1, $2, 'CAD', '0123456789AB', $3, $4, '1234', $5, $6, 1000, 1000, 'active', $7)`,
    [tenant.id, program.id, Buffer.from("not-a-real-ciphertext"), randomBytes(32), encryptionKeyId, lookupKeyId, user.id]
  );
}

before(async () => {
  await setupDatabase();
});
// The key-check table is shared state across boots, so every test starts and ends empty
beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await resetDb();
});
after(async () => {
  await teardownDatabase();
});

async function bootAndClose(config = loadTestConfig()): Promise<void> {
  const app: FastifyInstance = await buildTestApp(config);
  await app.close();
}

test("first boot stores check values", async () => {
  assert.equal((await checkRows()).length, 0);
  const config = loadTestConfig();
  await bootAndClose(config);

  const rows = await checkRows();
  const expected = expectedChecks(config);
  assert.equal(rows.length, 2);
  for (const e of expected) {
    const row = rows.find((r) => r.purpose === e.purpose && r.key_id === e.keyId);
    assert.ok(row, `a row for ${e.purpose} id ${e.keyId}`);
    assert.equal(row.check_value.length, 16);
    assert.ok(row.check_value.equals(e.checkValue));
  }
});

test("second boot succeeds", async () => {
  await bootAndClose();
  const before = await checkRows();
  await bootAndClose();
  const after = await checkRows();
  assert.deepEqual(
    after.map((r) => [r.purpose, r.key_id, r.check_value.toString("hex")]),
    before.map((r) => [r.purpose, r.key_id, r.check_value.toString("hex")])
  );
});

test("different encryption key, same id: fails naming CARD_ENCRYPTION_KEY", async () => {
  await bootAndClose();
  await assert.rejects(
    buildTestApp(loadTestConfig({ CARD_ENCRYPTION_KEY: OTHER_ENCRYPTION_KEY })),
    (err: Error) => {
      assert.match(err.message, /^CARD_ENCRYPTION_KEY does not match the key recorded for key id 1;/);
      assert.ok(!err.message.includes(OTHER_ENCRYPTION_KEY), "the message must not echo a key");
      return true;
    }
  );
});

test("same for CARD_LOOKUP_KEY", async () => {
  await bootAndClose();
  await assert.rejects(
    buildTestApp(loadTestConfig({ CARD_LOOKUP_KEY: OTHER_LOOKUP_KEY })),
    (err: Error) => {
      assert.match(err.message, /^CARD_LOOKUP_KEY does not match the key recorded for key id 1;/);
      assert.ok(!err.message.includes(OTHER_LOOKUP_KEY), "the message must not echo a key");
      return true;
    }
  );
});

test("new id with new key boots", async () => {
  await bootAndClose();
  await bootAndClose(
    loadTestConfig({
      CARD_ENCRYPTION_KEY: OTHER_ENCRYPTION_KEY,
      CARD_ENCRYPTION_KEY_ID: "2",
      CARD_LOOKUP_KEY: OTHER_LOOKUP_KEY,
      CARD_LOOKUP_KEY_ID: "2",
    })
  );
  const rows = await checkRows();
  assert.deepEqual(
    rows.map((r) => `${r.purpose}:${r.key_id}`),
    ["encryption:1", "encryption:2", "lookup:1", "lookup:2"]
  );
  // The original keys still boot against their own recorded values
  await bootAndClose();
});

test("row deleted while cards use the id: boot refused", async () => {
  for (const [purpose, variable] of [
    ["encryption", "CARD_ENCRYPTION_KEY"],
    ["lookup", "CARD_LOOKUP_KEY"],
  ]) {
    await resetDb();
    await bootAndClose();
    await insertCardUsingKeys(1, 1);

    await adminQuery(`DELETE FROM gift_card_key_checks WHERE purpose = $1`, [purpose]);
    await assert.rejects(buildTestApp(loadTestConfig()), (err: Error) => {
      assert.equal(
        err.message,
        `No key check recorded for ${variable} id 1 although cards use it; restore gift_card_key_checks or follow the README key-check reset procedure`
      );
      return true;
    });
    // Refusing does not re-pin the key
    assert.ok(!(await checkRows()).some((r) => r.purpose === purpose));
  }
});

test("row deleted and no cards use it: boot re-pins", async () => {
  await bootAndClose();
  await adminQuery(`DELETE FROM gift_card_key_checks`);

  const config = loadTestConfig({ CARD_ENCRYPTION_KEY: OTHER_ENCRYPTION_KEY, CARD_LOOKUP_KEY: OTHER_LOOKUP_KEY });
  await bootAndClose(config);

  const rows = await checkRows();
  assert.equal(rows.length, 2);
  for (const e of expectedChecks(config)) {
    assert.ok(rows.find((r) => r.purpose === e.purpose && r.key_id === e.keyId)?.check_value.equals(e.checkValue));
  }
  // and the new keys now boot, the old ones no longer do
  await bootAndClose(config);
  await assert.rejects(buildTestApp(loadTestConfig()), /does not match the key recorded for key id 1/);
});

test("first boot racing another instance's uncommitted write converges on the first writer", async () => {
  const config = loadTestConfig();
  const [encryption] = expectedChecks(config);

  // Another instance has recorded a different value for the encryption key but not yet committed
  const tx = await openAdminTransaction();
  try {
    await tx.query(`INSERT INTO gift_card_key_checks (purpose, key_id, check_value) VALUES ('encryption', 1, $1)`, [
      Buffer.alloc(16, 0xab),
    ]);
    const boot = buildTestApp(config);
    const outcome = boot.then(
      (app) => ({ app, err: undefined as Error | undefined }),
      (err: Error) => ({ app: undefined, err })
    );
    // Our INSERT ... ON CONFLICT DO NOTHING waits on the in-flight row
    await waitUntilBlocked(adminQuery, 1);
    await tx.commit();

    const result = await outcome;
    await result.app?.close();
    assert.ok(result.err, "the loser of the race must compare against the winner's value");
    assert.match(result.err.message, /^CARD_ENCRYPTION_KEY does not match the key recorded for key id 1;/);
    // The winner's value is untouched
    const rows = await checkRows();
    assert.ok(rows.find((r) => r.purpose === "encryption")?.check_value.equals(Buffer.alloc(16, 0xab)));
    assert.ok(!rows.find((r) => r.purpose === "encryption")?.check_value.equals(encryption.checkValue));
  } finally {
    await tx.rollback();
  }
});
