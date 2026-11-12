import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PASSWORD,
  UUID_V7,
  adminQuery,
  bearer,
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
  const other = (await import("fastify")).default();
  await other.register((await import("@fastify/jwt")).default, {
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

test("reusing a rotated refresh token is rejected and revokes the newer token too", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.com");
  const first = await login(getApp(), s.email);
  const rotated = (
    await send(getApp(), {
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: first.refreshToken },
    })
  ).json<Tokens>();

  const reuse = await send(getApp(), {
    method: "POST",
    url: "/auth/refresh",
    payload: { refreshToken: first.refreshToken },
  });
  assert.equal(reuse.statusCode, 401);

  const newer = await send(getApp(), {
    method: "POST",
    url: "/auth/refresh",
    payload: { refreshToken: rotated.refreshToken },
  });
  assert.equal(newer.statusCode, 401);
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
