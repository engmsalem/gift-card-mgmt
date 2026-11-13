import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDeliveryLink,
  DELIVERY_TOKEN_EXPIRES_AT_SQL,
  generateDeliveryToken,
  hashDeliveryToken,
} from "../../src/gift-cards/delivery-token";

test("43-char base64url", () => {
  const token = generateDeliveryToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(token, generateDeliveryToken());
  assert.equal(generateDeliveryToken(() => Buffer.alloc(32, 0xff)), "_".repeat(42) + "8");
  assert.throws(() => generateDeliveryToken(() => Buffer.alloc(31)), RangeError);
});

test("hash 32 bytes", () => {
  const hash = hashDeliveryToken("abc");
  assert.equal(hash.length, 32);
  assert.equal(hash.toString("hex"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.notDeepEqual(hash, hashDeliveryToken("abd"));
});

test("token in fragment", () => {
  const link = buildDeliveryLink("https://gifts.example.com/gift", "TOKEN");
  assert.equal(link, "https://gifts.example.com/gift#token=TOKEN");
  assert.equal(new URL(link).search, "");
  assert.equal(new URL(link).hash, "#token=TOKEN");
});

test("expiry is 90 days, computed by the database clock", () => {
  assert.equal(DELIVERY_TOKEN_EXPIRES_AT_SQL, "now() + interval '90 days'");
});
