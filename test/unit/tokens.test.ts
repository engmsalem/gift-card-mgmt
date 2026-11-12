import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { generateRefreshToken, hashRefreshToken } from "../../src/tokens";

test("hashRefreshToken is a deterministic SHA-256 hex digest", () => {
  const expected = createHash("sha256").update("abc").digest("hex");
  assert.equal(hashRefreshToken("abc"), expected);
  assert.equal(hashRefreshToken("abc"), hashRefreshToken("abc"));
  assert.match(hashRefreshToken("abc"), /^[0-9a-f]{64}$/);
  assert.notEqual(hashRefreshToken("abc"), hashRefreshToken("abd"));
});

test("generateRefreshToken returns unique 43-char base64url strings", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const token = generateRefreshToken();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    seen.add(token);
  }
  assert.equal(seen.size, 100);
});
