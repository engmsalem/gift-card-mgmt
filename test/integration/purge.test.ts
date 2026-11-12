import { test } from "node:test";
import assert from "node:assert/strict";
import { adminQuery, login, signupTenant, useTestApp } from "./helpers";

const getApp = useTestApp();

test("purgeExpiredRefreshTokens deletes expired rows (any user) and keeps the rest", async () => {
  const a = await signupTenant(getApp(), "acme", "ada@acme.com");
  const b = await signupTenant(getApp(), "globex", "bob@globex.com");
  await login(getApp(), a.email); // active
  await login(getApp(), a.email); // revoked below, unexpired
  await login(getApp(), b.email); // expired, active
  await login(getApp(), b.email); // expired, revoked
  await adminQuery(
    "UPDATE refresh_tokens SET revoked_at = now(), revoke_reason = 'logout' WHERE id IN (SELECT id FROM refresh_tokens ORDER BY created_at OFFSET 1 LIMIT 1)"
  );
  await adminQuery(
    "UPDATE refresh_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1",
    [b.adminId]
  );
  await adminQuery(
    "UPDATE refresh_tokens SET revoked_at = now(), revoke_reason = 'logout' WHERE user_id = $1 AND id = (SELECT id FROM refresh_tokens WHERE user_id = $1 ORDER BY created_at LIMIT 1)",
    [b.adminId]
  );

  // eslint-disable-next-line @typescript-eslint/no-require-imports -- must load after helpers switch DB_DATABASE
  const { purgeExpiredRefreshTokens } = require("../../src/scripts/purge-refresh-tokens") as typeof import("../../src/scripts/purge-refresh-tokens");
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- same
  const { AppDataSource } = require("../../src/data-source") as typeof import("../../src/data-source");

  assert.equal(await purgeExpiredRefreshTokens(AppDataSource), 2);

  const rows = (await adminQuery(
    "SELECT user_id, revoked_at IS NOT NULL AS revoked FROM refresh_tokens ORDER BY created_at"
  )) as { user_id: string; revoked: boolean }[];
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.user_id === a.adminId));
  assert.deepEqual(rows.map((r) => r.revoked), [false, true]);
  assert.equal(await purgeExpiredRefreshTokens(AppDataSource), 0);
});
