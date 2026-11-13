import { test } from "node:test";
import assert from "node:assert/strict";
import type { DataSource } from "typeorm";
import { dispatchAllDue } from "../../src/scripts/dispatch-deliveries";
import { DeliveryDispatcher } from "../../src/services/deliveryDispatcher";

// A database whose claim transaction fails, as when the connection is down
function brokenDispatcher(warnings: object[] = []): DeliveryDispatcher {
  const db = { transaction: () => Promise.reject(new Error("connection refused")) } as unknown as DataSource;
  return new DeliveryDispatcher({
    db,
    sender: { send: () => Promise.resolve() },
    linkBaseUrl: "http://localhost:3000/gift",
    log: { info: () => undefined, warn: (o) => void warnings.push(o) },
  });
}

test("in-request dispatch: a database failure is logged and resolves with 0", async () => {
  const warnings: object[] = [];
  assert.equal(await brokenDispatcher(warnings).dispatch({ deliveryId: "d1" }), 0);
  assert.deepEqual(warnings, [{ deliveryId: "d1", errName: "Error" }]);
});

test("dispatch with throwOnError: a database failure rejects", async () => {
  await assert.rejects(brokenDispatcher().dispatch({ throwOnError: true }), /connection refused/);
});

test("the script's dispatchAllDue rejects when the database fails, so the cron job exits non-zero", async () => {
  await assert.rejects(dispatchAllDue(brokenDispatcher()), /connection refused/);
});
