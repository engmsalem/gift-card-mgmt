import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { CardCrypto, CardCryptoError } from "../../src/gift-cards/card-crypto";

const KEY_A = Buffer.alloc(32, 0xa1);
const KEY_B = Buffer.alloc(32, 0xb2);
const KEY_C = Buffer.alloc(32, 0xc3);
const ids = { tenantId: "tenant-1", cardId: "card-1" };

const make = (enc = KEY_A, lookup = KEY_B, encId = 1, lookupId = 1) =>
  new CardCrypto({ encryption: { id: encId, key: enc }, lookup: { id: lookupId, key: lookup } });

test("round trip", () => {
  const crypto = make();
  const blob = crypto.encrypt("number", ids, "7000123412341234");
  assert.equal(blob[0], 0x01);
  assert.equal(blob.length, 1 + 12 + 16 + 16);
  assert.ok(!blob.toString("latin1").includes("7000123412341234"));
  assert.equal(crypto.decrypt("number", ids, 1, blob), "7000123412341234");
  assert.equal(crypto.decrypt("pin", ids, 1, crypto.encrypt("pin", ids, "654321")), "654321");
  assert.equal(crypto.decrypt("pin", ids, 1, crypto.encrypt("pin", ids, "")), "");
});

test("fresh IV", () => {
  const crypto = make();
  const a = crypto.encrypt("number", ids, "same");
  const b = crypto.encrypt("number", ids, "same");
  assert.notDeepEqual(a.subarray(1, 13), b.subarray(1, 13));
  assert.notDeepEqual(a, b);
  // the injected source is the only entropy
  const fixed = new CardCrypto(
    { encryption: { id: 1, key: KEY_A }, lookup: { id: 1, key: KEY_B } },
    (n) => Buffer.alloc(n, 9)
  );
  assert.deepEqual(fixed.encrypt("number", ids, "x"), fixed.encrypt("number", ids, "x"));
  assert.deepEqual(fixed.encrypt("number", ids, "x").subarray(1, 13), Buffer.alloc(12, 9));
  const short = new CardCrypto(
    { encryption: { id: 1, key: KEY_A }, lookup: { id: 1, key: KEY_B } },
    () => Buffer.alloc(8)
  );
  assert.throws(() => short.encrypt("number", ids, "x"), CardCryptoError);
});

test("AAD mismatch (cardId/tenantId/purpose/key id) fails", () => {
  const crypto = make();
  const blob = crypto.encrypt("number", ids, "7000123412341234");
  assert.throws(() => crypto.decrypt("number", { ...ids, cardId: "card-2" }, 1, blob), CardCryptoError);
  assert.throws(() => crypto.decrypt("number", { ...ids, tenantId: "tenant-2" }, 1, blob), CardCryptoError);
  assert.throws(() => crypto.decrypt("pin", ids, 1, blob), CardCryptoError);
  // the same key bound to a different id: the key id is in the AAD
  const rekeyed = make(KEY_A, KEY_B, 2);
  assert.throws(() => rekeyed.decrypt("number", ids, 2, blob), CardCryptoError);
});

test("tampered tag or ciphertext fails", () => {
  const crypto = make();
  const blob = crypto.encrypt("number", ids, "7000123412341234");
  for (const index of [1, 12, 13, 28, 29, blob.length - 1]) {
    const bad = Buffer.from(blob);
    bad[index] ^= 0x01;
    assert.throws(() => crypto.decrypt("number", ids, 1, bad), CardCryptoError, `byte ${index}`);
  }
  assert.throws(() => crypto.decrypt("number", ids, 1, Buffer.concat([blob, Buffer.of(0)])), CardCryptoError);
});

test("unknown version fails", () => {
  const crypto = make();
  const blob = crypto.encrypt("number", ids, "x");
  blob[0] = 0x02;
  assert.throws(() => crypto.decrypt("number", ids, 1, blob), CardCryptoError);
});

test("unknown key id fails", () => {
  const crypto = make();
  const blob = crypto.encrypt("number", ids, "x");
  assert.throws(() => crypto.decrypt("number", ids, 2, blob), /Unknown card key id/);
});

test("short blob fails", () => {
  const crypto = make();
  for (const length of [0, 1, 12, 28]) {
    assert.throws(() => crypto.decrypt("number", ids, 1, Buffer.alloc(length, 1)), CardCryptoError, String(length));
  }
});

test("decrypt errors carry no data", () => {
  const crypto = make();
  const blob = crypto.encrypt("number", ids, "7000123412341234");
  blob[blob.length - 1] ^= 1;
  try {
    crypto.decrypt("number", ids, 1, blob);
    assert.fail("expected failure");
  } catch (err) {
    assert.ok(err instanceof CardCryptoError);
    assert.equal(err.name, "CardCryptoError");
    assert.equal(err.message, "Decryption failed");
    assert.ok(!("cause" in err));
  }
});

test("constructor rejects 31-byte key, equal keys, id 0", () => {
  assert.throws(() => make(Buffer.alloc(31, 1), KEY_B), CardCryptoError);
  assert.throws(() => make(KEY_A, Buffer.alloc(33, 1)), CardCryptoError);
  assert.throws(() => make(KEY_A, KEY_A), /must differ/);
  assert.throws(() => make(KEY_A, Buffer.from(KEY_A)), /must differ/);
  assert.throws(() => make(KEY_A, KEY_B, 0), CardCryptoError);
  assert.throws(() => make(KEY_A, KEY_B, 1, 0), CardCryptoError);
  assert.throws(() => make(KEY_A, KEY_B, 32768), CardCryptoError);
  assert.throws(() => make(KEY_A, KEY_B, 1.5), CardCryptoError);
  assert.ok(make(KEY_A, KEY_B, 32767, 32767));
});

test("constructor errors do not echo key material", () => {
  try {
    make(KEY_A, KEY_A);
    assert.fail("expected failure");
  } catch (err) {
    const message = (err as Error).message;
    assert.ok(!message.includes(KEY_A.toString("hex")) && !message.includes("a1a1"));
  }
});

test("lookupHash deterministic and key-dependent", () => {
  const crypto = make();
  const hash = crypto.lookupHash("7000123412341234");
  assert.equal(hash.length, 32);
  assert.deepEqual(hash, crypto.lookupHash("7000123412341234"));
  assert.notDeepEqual(hash, crypto.lookupHash("7000123412341235"));
  assert.notDeepEqual(hash, make(KEY_A, KEY_C).lookupHash("7000123412341234"));
  // independent of the encryption key and of the key ids
  assert.deepEqual(hash, make(KEY_C, KEY_B, 5, 9).lookupHash("7000123412341234"));
  assert.deepEqual(hash, createHmac("sha256", KEY_B).update("gift-card-number:v1:7000123412341234").digest());
});

test("keyCheckValues stable, key-dependent, and not equal to HMAC(rawKey, label)", () => {
  const values = make().keyCheckValues();
  assert.deepEqual(values.map((v) => [v.purpose, v.keyId]), [["encryption", 1], ["lookup", 1]]);
  for (const v of values) assert.equal(v.checkValue.length, 16);
  assert.deepEqual(make().keyCheckValues(), values);
  assert.notDeepEqual(values[0].checkValue, values[1].checkValue);

  // a different key, and a different key id, change the value
  assert.notDeepEqual(make(KEY_C, KEY_B).keyCheckValues()[0].checkValue, values[0].checkValue);
  assert.deepEqual(make(KEY_A, KEY_C).keyCheckValues()[0].checkValue, values[0].checkValue);
  assert.notDeepEqual(make(KEY_A, KEY_C).keyCheckValues()[1].checkValue, values[1].checkValue);
  assert.notDeepEqual(make(KEY_A, KEY_B, 2).keyCheckValues()[0].checkValue, values[0].checkValue);

  // the check value must not be an HMAC keyed directly by the raw key
  const raw = createHmac("sha256", KEY_A).update("kcv:1").digest().subarray(0, 16);
  assert.notDeepEqual(values[0].checkValue, raw);
  const rawLabelled = createHmac("sha256", KEY_A).update("gift-card-key-check:v1:encryption").digest().subarray(0, 16);
  assert.notDeepEqual(values[0].checkValue, rawLabelled);
});
