import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabase, resolveTestDatabase } from "../support/test-db";

test("resolveTestDatabase derives <db>_test from DB_DATABASE", () => {
  assert.equal(resolveTestDatabase({ DB_DATABASE: "gcm" }), "gcm_test");
});

test("resolveTestDatabase prefers an explicit TEST_DB_DATABASE", () => {
  assert.equal(
    resolveTestDatabase({ DB_DATABASE: "gcm", TEST_DB_DATABASE: "ci_scratch" }),
    "ci_scratch"
  );
});

test("resolveTestDatabase throws when no database can be determined", () => {
  assert.throws(() => resolveTestDatabase({}), /Cannot determine the test database/);
});

test("assertTestDatabase accepts names ending in _test", () => {
  assert.doesNotThrow(() => assertTestDatabase("gcm_test", {}));
});

test("assertTestDatabase refuses a non-test database", () => {
  assert.throws(() => assertTestDatabase("gcm", {}), /must end in "_test"/);
  assert.throws(() => assertTestDatabase(undefined, {}), /must end in "_test"/);
});

test("assertTestDatabase allows a non-_test name only when it is the explicit TEST_DB_DATABASE", () => {
  assert.doesNotThrow(() => assertTestDatabase("ci_scratch", { TEST_DB_DATABASE: "ci_scratch" }));
  assert.throws(
    () => assertTestDatabase("gcm", { TEST_DB_DATABASE: "ci_scratch" }),
    /must end in "_test"/
  );
});
