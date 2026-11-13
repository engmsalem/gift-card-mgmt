import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Config } from "../../src/config";
import { Role } from "../../src/enums/roles";
import {
  bearer,
  buildTestApp,
  loadTestConfig,
  resetDb,
  send,
  setupDatabase,
  signupTenant,
  teardownDatabase,
} from "./helpers";

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

test("a token signed with one app's JWT_SECRET is rejected by an app with another", async () => {
  await resetDb();
  const appA = await buildTestApp(loadTestConfig({ JWT_SECRET: "a".repeat(40) }));
  const appB = await buildTestApp(loadTestConfig({ JWT_SECRET: "b".repeat(40) }));
  try {
    const { adminId, tenantId } = await signupTenant(appA, "isolation", "admin@isolation.example");
    const token = appA.jwt.sign({ sub: adminId, tid: tenantId, role: Role.ADMIN, typ: "access" });
    assert.equal((await send(appA, { method: "GET", url: "/users/me", headers: bearer(token) })).statusCode, 200);
    assert.equal((await send(appB, { method: "GET", url: "/users/me", headers: bearer(token) })).statusCode, 401);
  } finally {
    await appA.close();
    await appB.close();
  }
});

test("buildApp rejects a hand-built config with a short JWT secret", async () => {
  const config: Config = { ...loadTestConfig(), jwtSecret: "too-short" };
  await assert.rejects(buildTestApp(config), /JWT secret must be at least 32 characters/);
});

test("loadTestConfig can unset a passthrough variable with undefined", () => {
  assert.throws(() => loadTestConfig({ JWT_SECRET: undefined }), /JWT_SECRET is required/);
});
