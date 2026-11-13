import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ConfigError } from "../../src/config";
import { RecordingDeliverySender } from "../support/recording-delivery-sender";
import { buildTestApp, loadTestConfig, resetDb, setupDatabase, teardownDatabase } from "./helpers";

// Production refuses the published test keys, so use others
const productionConfig = () =>
  loadTestConfig({
    NODE_ENV: "production",
    CORS_ORIGIN: "*",
    GIFT_CARD_LINK_BASE_URL: "https://gifts.example.com/gift",
    CARD_ENCRYPTION_KEY: createHash("sha256").update("provider-test-encryption").digest("hex"),
    CARD_LOOKUP_KEY: createHash("sha256").update("provider-test-lookup").digest("hex"),
  });

before(async () => {
  await setupDatabase();
});
beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await resetDb();
});
after(async () => {
  await teardownDatabase();
});

test("production with no delivery sender: buildApp rejects with a ConfigError", async () => {
  await assert.rejects(buildTestApp(productionConfig()), (err: Error) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /no provider configured/);
    return true;
  });
});

test("production with an injected sender builds", async () => {
  const app = await buildTestApp(productionConfig(), { deliverySender: new RecordingDeliverySender() });
  await app.close();
});

test("outside production, with no sender configured, the app builds (log-only)", async () => {
  const app = await buildTestApp(loadTestConfig());
  await app.close();
});
