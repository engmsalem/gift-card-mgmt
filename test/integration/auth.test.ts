import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fastifyJwt from "@fastify/jwt";
import Fastify from "fastify";
import {
  PASSWORD,
  UUID_V7,
  adminQuery,
  bearer,
  buildTestApp,
  login,
  send,
  signupTenant,
  useTestApp,
  type Tokens,
  type UserDto,
} from "./helpers";

const getApp = useTestApp();

test("login returns an access/refresh pair", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.com");
  const tokens = await login(getApp(), s.email);
  assert.equal(tokens.expiresIn, 900);
  assert.match(tokens.refreshToken, /^[A-Za-z0-9_-]{43}$/);
  const payload = getApp().jwt.decode<Record<string, unknown>>(tokens.accessToken);
  assert.equal(payload?.sub, s.adminId);
  assert.equal(payload?.tid, s.tenantId);
  assert.match(String(payload?.sub), UUID_V7);
  assert.match(String(payload?.tid), UUID_V7);
  assert.equal(payload?.role, "admin");
  assert.equal(payload?.typ, "access");
});

test("login normalizes the email", async () => {
  await signupTenant(getApp(), "acme", "ada@acme.com");
  const tokens = await login(getApp(), "  ADA@acme.com ");
  assert.ok(tokens.accessToken);
});

test("refresh tokens are stored hashed, never raw", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.com");
  const tokens = await login(getApp(), s.email);
  const rows = (await adminQuery("SELECT token_hash FROM refresh_tokens")) as {
    token_hash: string;
  }[];
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, tokens.refreshToken);
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
});

test("wrong password and unknown email give the identical 401", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.com");
  const wrong = await send(getApp(), {
    method: "POST",
    url: "/auth/login",
    payload: { email: s.email, password: "not-the-password" },
  });
  const unknown = await send(getApp(), {
    method: "POST",
    url: "/auth/login",
    payload: { email: "nobody@acme.com", password: PASSWORD },
  });
  assert.equal(wrong.statusCode, 401);
  assert.equal(unknown.statusCode, 401);
  assert.equal(wrong.body, unknown.body);
  assert.deepEqual(wrong.json(), { error: "Invalid email or password" });
});

test("login is rate limited to 10 per minute", async () => {
  let last = 0;
  for (let i = 0; i < 11; i++) {
    const res = await send(getApp(), {
      method: "POST",
      url: "/auth/login",
      payload: { email: "nobody@acme.com", password: "x" },
    });
    last = res.statusCode;
  }
  assert.equal(last, 429);
});

test("access token authenticates GET /users/me", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.com");
  const tokens = await login(getApp(), s.email);
  const res = await send(getApp(), {
    method: "GET",
    url: "/users/me",
    headers: bearer(tokens.accessToken),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json<UserDto>().id, s.adminId);
  assert.equal(res.json<UserDto>().email, s.email);
});

test("no token returns 401", async () => {
  const res = await send(getApp(), { method: "GET", url: "/users/me" });
  assert.equal(res.statusCode, 401);
});

test("garbage token returns 401", async () => {
  const res = await send(getApp(), {
    method: "GET",
    url: "/users/me",
    headers: bearer("not.a.jwt"),
  });
  assert.equal(res.statusCode, 401);
});

test("a refresh token sent as Bearer returns 401", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.com");
  const tokens = await login(getApp(), s.email);
  const res = await send(getApp(), {
    method: "GET",
    url: "/users/me",
    headers: bearer(tokens.refreshToken),
  });
  assert.equal(res.statusCode, 401);
});

test("a validly signed JWT with typ refresh or without typ returns 401", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.com");
  const claims = { sub: s.adminId, tid: s.tenantId, role: "admin" };
  for (const extra of [{ typ: "refresh" }, {}]) {
    const token = getApp().jwt.sign({ ...claims, ...extra } as never);
    const res = await send(getApp(), { method: "GET", url: "/users/me", headers: bearer(token) });
    assert.equal(res.statusCode, 401, JSON.stringify(extra));
  }
});

test("a JWT signed with another secret returns 401", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.com");
  const other = Fastify();
  await other.register(fastifyJwt, {
    secret: "a-completely-different-secret-of-sufficient-length",
  });
  await other.ready();
  const token = other.jwt.sign({
    sub: s.adminId,
    tid: s.tenantId,
    role: "admin" as never,
    typ: "access",
  });
  await other.close();
  const res = await send(getApp(), { method: "GET", url: "/users/me", headers: bearer(token) });
  assert.equal(res.statusCode, 401);
});

test("refresh rotates: new pair works, old token is rejected", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.com");
  const first = await login(getApp(), s.email);

  const res = await send(getApp(), {
    method: "POST",
    url: "/auth/refresh",
    payload: { refreshToken: first.refreshToken },
  });
  assert.equal(res.statusCode, 200);
  const second = res.json<Tokens>();
  assert.notEqual(second.refreshToken, first.refreshToken);
  assert.equal(second.expiresIn, 900);

  const me = await send(getApp(), {
    method: "GET",
    url: "/users/me",
    headers: bearer(second.accessToken),
  });
  assert.equal(me.statusCode, 200);
});

async function refreshWith(refreshToken: string) {
  return send(getApp(), { method: "POST", url: "/auth/refresh", payload: { refreshToken } });
}

test("a rotated token presented again right away is rejected without revoking the newer pair", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.com");
  const first = await login(getApp(), s.email);
  const rotated = (await refreshWith(first.refreshToken)).json<Tokens>();

  // Two tabs / a client retry racing on the same token: only the loser gets a 401
  assert.equal((await refreshWith(first.refreshToken)).statusCode, 401);

  const me = await send(getApp(), {
    method: "GET",
    url: "/users/me",
    headers: bearer(rotated.accessToken),
  });
  assert.equal(me.statusCode, 200);
  assert.equal((await refreshWith(rotated.refreshToken)).statusCode, 200);
});

test("reusing a rotated refresh token after the grace window is rejected and revokes the newer token too", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.com");
  const first = await login(getApp(), s.email);
  const rotated = (await refreshWith(first.refreshToken)).json<Tokens>();

  // Only the first token is revoked so far
  await adminQuery(
    "UPDATE refresh_tokens SET revoked_at = now() - interval '1 minute' WHERE revoked_at IS NOT NULL"
  );

  assert.equal((await refreshWith(first.refreshToken)).statusCode, 401);
  assert.equal((await refreshWith(rotated.refreshToken)).statusCode, 401);

  const reasons = (await adminQuery(
    "SELECT revoke_reason FROM refresh_tokens ORDER BY created_at"
  )) as { revoke_reason: string }[];
  assert.deepEqual(reasons.map((r) => r.revoke_reason), ["rotated", "reuse"]);
});

test("revoke reasons are persisted: rotated, logout, and NULL while active", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.com");
  const a = await login(getApp(), s.email);
  const b = await login(getApp(), s.email);
  const rotated = (await refreshWith(a.refreshToken)).json<Tokens>();
  await send(getApp(), {
    method: "POST",
    url: "/auth/logout",
    payload: { refreshToken: b.refreshToken },
  });

  const rows = (await adminQuery(
    "SELECT token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex') AS is_new, revoke_reason FROM refresh_tokens ORDER BY created_at",
    [rotated.refreshToken]
  )) as { is_new: boolean; revoke_reason: string | null }[];
  assert.deepEqual(rows.map((r) => r.revoke_reason), ["rotated", "logout", null]);
  assert.equal(rows[2].is_new, true);
});

test("a logged-out token presented after the grace window is rejected without revoking other devices", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.com");
  const deviceA = await login(getApp(), s.email);
  const deviceB = await login(getApp(), s.email);
  await send(getApp(), {
    method: "POST",
    url: "/auth/logout",
    payload: { refreshToken: deviceA.refreshToken },
  });
  await adminQuery(
    "UPDATE refresh_tokens SET revoked_at = now() - interval '1 minute' WHERE revoked_at IS NOT NULL"
  );

  assert.equal((await refreshWith(deviceA.refreshToken)).statusCode, 401);
  assert.equal((await refreshWith(deviceB.refreshToken)).statusCode, 200);
});

test("the oldest active refresh tokens beyond the cap are evicted without triggering theft handling", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.com");
  const logins: Tokens[] = [];
  // A fresh app per login: login is rate limited to 10 per minute per app instance
  for (let i = 0; i < 11; i++) {
    const app = await buildTestApp();
    try {
      logins.push(await login(app, s.email));
    } finally {
      await app.close();
    }
  }

  const counts = (await adminQuery(
    "SELECT count(*) FILTER (WHERE revoked_at IS NULL)::int AS active, count(*) FILTER (WHERE revoke_reason = 'evicted')::int AS evicted FROM refresh_tokens"
  )) as { active: number; evicted: number }[];
  assert.deepEqual(counts[0], { active: 10, evicted: 1 });

  await adminQuery(
    "UPDATE refresh_tokens SET revoked_at = now() - interval '1 minute' WHERE revoked_at IS NOT NULL"
  );
  assert.equal((await refreshWith(logins[0].refreshToken)).statusCode, 401);
  assert.equal((await refreshWith(logins[1].refreshToken)).statusCode, 200);
  assert.equal((await refreshWith(logins[10].refreshToken)).statusCode, 200);
});

test("a failure while issuing the new pair rolls the revocation back", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.com");
  const tokens = await login(getApp(), s.email);

  // Make inserting the new (unrevoked) token fail; revoking the old one still passes
  // (as the admin role, which owns the table)
  await adminQuery(
    "ALTER TABLE refresh_tokens ADD CONSTRAINT test_reject_new CHECK (revoked_at IS NOT NULL) NOT VALID"
  );
  try {
    assert.equal((await refreshWith(tokens.refreshToken)).statusCode, 500);
  } finally {
    await adminQuery("ALTER TABLE refresh_tokens DROP CONSTRAINT test_reject_new");
  }

  // The old token was not consumed
  assert.equal((await refreshWith(tokens.refreshToken)).statusCode, 200);
});

test("login deletes the user's expired refresh tokens but keeps revoked unexpired ones", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.com");
  const expired = await login(getApp(), s.email);
  const revoked = await login(getApp(), s.email);
  await send(getApp(), {
    method: "POST",
    url: "/auth/logout",
    payload: { refreshToken: revoked.refreshToken },
  });
  await adminQuery(
    "UPDATE refresh_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')",
    [expired.refreshToken]
  );

  await login(getApp(), s.email);

  const rows = (await adminQuery(
    "SELECT revoked_at IS NOT NULL AS revoked, expires_at > now() AS live FROM refresh_tokens ORDER BY created_at"
  )) as { revoked: boolean; live: boolean }[];
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.revoked), [true, false]);
  assert.ok(rows.every((r) => r.live));
});

test("refresh tokens expire in 7 days by the database clock", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.com");
  await login(getApp(), s.email);
  const rows = (await adminQuery(
    "SELECT extract(epoch FROM expires_at - created_at)::int AS ttl FROM refresh_tokens"
  )) as { ttl: number }[];
  assert.equal(rows[0].ttl, 7 * 24 * 60 * 60);
});

test("an expired refresh token is rejected", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.com");
  const tokens = await login(getApp(), s.email);
  await adminQuery("UPDATE refresh_tokens SET expires_at = now() - interval '1 minute'");
  const res = await send(getApp(), {
    method: "POST",
    url: "/auth/refresh",
    payload: { refreshToken: tokens.refreshToken },
  });
  assert.equal(res.statusCode, 401);
});

test("an unknown refresh token is rejected", async () => {
  const res = await send(getApp(), {
    method: "POST",
    url: "/auth/refresh",
    payload: { refreshToken: "x".repeat(43) },
  });
  assert.equal(res.statusCode, 401);
});

test("refresh picks up the user's current role", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.com");
  const tokens = await login(getApp(), s.email);
  await adminQuery("UPDATE users SET role = 'staff' WHERE id = $1", [s.adminId]);
  const res = await send(getApp(), {
    method: "POST",
    url: "/auth/refresh",
    payload: { refreshToken: tokens.refreshToken },
  });
  assert.equal(res.statusCode, 200);
  const payload = getApp().jwt.decode<Record<string, unknown>>(res.json<Tokens>().accessToken);
  assert.equal(payload?.role, "staff");
});

test("logout revokes the refresh token; logging out twice is still 204", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.com");
  const tokens = await login(getApp(), s.email);

  for (let i = 0; i < 2; i++) {
    const res = await send(getApp(), {
      method: "POST",
      url: "/auth/logout",
      payload: { refreshToken: tokens.refreshToken },
    });
    assert.equal(res.statusCode, 204);
  }

  const refresh = await send(getApp(), {
    method: "POST",
    url: "/auth/refresh",
    payload: { refreshToken: tokens.refreshToken },
  });
  assert.equal(refresh.statusCode, 401);
});

test("logout with an unknown token is 204", async () => {
  const res = await send(getApp(), {
    method: "POST",
    url: "/auth/logout",
    payload: { refreshToken: "x".repeat(43) },
  });
  assert.equal(res.statusCode, 204);
});

test("a non-string refreshToken is rejected, not coerced", async () => {
  const res = await send(getApp(), {
    method: "POST",
    url: "/auth/refresh",
    payload: { refreshToken: 123 },
  });
  assert.equal(res.statusCode, 400);
});

test("CORS headers are set on a rate-limited 429 response", async () => {
  let last: Awaited<ReturnType<typeof send>> | undefined;
  for (let i = 0; i < 11; i++) {
    last = await send(getApp(), {
      method: "POST",
      url: "/auth/login",
      headers: { origin: "https://app.example" },
      payload: { email: "nobody@acme.com", password: "x" },
    });
  }
  assert.equal(last?.statusCode, 429);
  assert.ok(last?.headers["access-control-allow-origin"], "429 must carry CORS headers");
});

test("a CORS preflight is answered with 204 and does not consume the login rate limit", async () => {
  const preflight = {
    method: "OPTIONS",
    url: "/auth/login",
    headers: { origin: "https://app.example", "access-control-request-method": "POST" },
  } as const;
  const first = await send(getApp(), preflight);
  assert.equal(first.statusCode, 204);
  assert.ok(first.headers["access-control-allow-origin"]);
  assert.ok(first.headers["access-control-allow-methods"]);

  for (let i = 0; i < 9; i++) {
    assert.equal((await send(getApp(), preflight)).statusCode, 204);
  }
  for (let i = 0; i < 10; i++) {
    const res = await send(getApp(), {
      method: "POST",
      url: "/auth/login",
      payload: { email: "nobody@acme.com", password: "x" },
    });
    assert.notEqual(res.statusCode, 429, `login ${i + 1}`);
  }
});

test("concurrent refreshes for a user over the session cap never fail with a server error", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.com");
  const userId = s.adminId;
  const SESSIONS = 12;
  const CONCURRENCY = 5;
  const ROUNDS = 12;

  // Seed more active sessions than the cap directly (login is rate limited)
  const pool: string[] = [];
  for (let i = 0; i < SESSIONS; i++) {
    const raw = randomBytes(32).toString("base64url");
    pool.push(raw);
    await adminQuery(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, created_at)
       VALUES ($1, $2, now() + interval '7 days', now() - ($3 || ' seconds')::interval)`,
      [userId, createHash("sha256").update(raw).digest("hex"), String(SESSIONS - i)]
    );
  }

  for (let round = 0; round < ROUNDS; round++) {
    // The newest tokens are never evicted, so these are always valid and distinct
    const batch = pool.splice(-CONCURRENCY);
    const results = await Promise.all(
      batch.map((refreshToken) => refreshWith(refreshToken))
    );
    for (const res of results) {
      assert.equal(res.statusCode, 200, `round ${round}: ${res.body}`);
      pool.push(res.json<Tokens>().refreshToken);
    }
  }

  // One more, uncontended issue converges on the cap
  await login(getApp(), s.email);
  const rows = (await adminQuery(
    "SELECT count(*)::int AS active FROM refresh_tokens WHERE revoked_at IS NULL AND expires_at > now()"
  )) as { active: number }[];
  assert.ok(rows[0].active <= 10, `active tokens: ${rows[0].active}`);
});
