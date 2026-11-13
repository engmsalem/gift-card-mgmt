import { test } from "node:test";
import assert from "node:assert/strict";
import { maskEmail } from "../../src/gift-cards/mask";

test("maskEmail keeps first character and domain only", () => {
  assert.equal(maskEmail("alice@example.com"), "a***@example.com");
  assert.equal(maskEmail("a@example.com"), "a***@example.com");
  assert.ok(!maskEmail("alice.smith@example.com").includes("smith"));
  assert.equal(maskEmail("nodomain"), "***");
  assert.equal(maskEmail("@example.com"), "***");
  assert.equal(maskEmail(""), "***");
});
