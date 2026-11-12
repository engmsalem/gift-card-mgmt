import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, loadTestConfig, setupDatabase, teardownDatabase } from "./helpers";

before(async () => {
  await setupDatabase();
});
after(async () => {
  await teardownDatabase();
});

test("two apps in one process use their own config", async () => {
  const appA = await buildTestApp(loadTestConfig({ CORS_ORIGIN: "https://a.example" }));
  const appB = await buildTestApp(loadTestConfig({ CORS_ORIGIN: "https://b.example" }));
  try {
    const request = { method: "GET", url: "/users/me", headers: { origin: "https://a.example" } } as const;
    const fromA = await appA.inject(request);
    const fromB = await appB.inject(request);
    assert.equal(fromA.headers["access-control-allow-origin"], "https://a.example");
    assert.equal(fromB.headers["access-control-allow-origin"], "https://b.example");
  } finally {
    await appA.close();
    await appB.close();
  }
});
