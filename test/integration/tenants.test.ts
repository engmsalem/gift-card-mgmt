import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PASSWORD,
  UUID_V7,
  adminQuery,
  send,
  signupTenant,
  useTestApp,
  type TenantDto,
  type UserDto,
} from "./helpers";

const getApp = useTestApp();

function signupPayload(overrides: { tenant?: object; admin?: object } = {}) {
  return {
    tenant: { name: "Acme", subdomain: "acme", ...overrides.tenant },
    admin: { name: "Ada", email: "ada@acme.com", password: PASSWORD, ...overrides.admin },
  };
}

test("signup creates a tenant and its first admin", async () => {
  const res = await send(getApp(), { method: "POST", url: "/tenants", payload: signupPayload() });
  assert.equal(res.statusCode, 201);
  const body = res.json<{ tenant: TenantDto; user: UserDto }>();
  assert.equal(body.tenant.subdomain, "acme");
  assert.equal(body.user.email, "ada@acme.com");
  assert.equal(body.user.role, "admin");
  assert.equal(body.user.tenantId, body.tenant.id);
  assert.match(body.user.id, UUID_V7);
  assert.match(body.tenant.id, UUID_V7);
  assert.match(body.user.tenantId, UUID_V7);
});

test("signup trims and lowercases the email", async () => {
  const res = await send(getApp(), {
    method: "POST",
    url: "/tenants",
    payload: signupPayload({ admin: { email: "  Ada@Acme.COM " } }),
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json<{ user: UserDto }>().user.email, "ada@acme.com");
});

test("duplicate subdomain returns 409", async () => {
  await signupTenant(getApp(), "acme", "one@x.com");
  const res = await send(getApp(), {
    method: "POST",
    url: "/tenants",
    payload: signupPayload({ admin: { email: "two@x.com" } }),
  });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { error: "Subdomain already taken" });
});

test("duplicate email returns 409, case-insensitively, and creates no tenant", async () => {
  await signupTenant(getApp(), "first", "a@x.com");
  const res = await send(getApp(), {
    method: "POST",
    url: "/tenants",
    payload: signupPayload({ tenant: { subdomain: "second" }, admin: { email: "A@x.com" } }),
  });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { error: "Email already registered" });
  const rows = (await adminQuery("SELECT count(*)::int AS n FROM tenants")) as { n: number }[];
  assert.equal(rows[0].n, 1);
});

for (const subdomain of ["Acme", "a", "-acme", "acme-", "has space", "under_score", "a".repeat(51)]) {
  test(`invalid subdomain "${subdomain}" returns 400`, async () => {
    const res = await send(getApp(), {
      method: "POST",
      url: "/tenants",
      payload: signupPayload({ tenant: { subdomain } }),
    });
    assert.equal(res.statusCode, 400);
  });
}

test("short password returns 400", async () => {
  const res = await send(getApp(), {
    method: "POST",
    url: "/tenants",
    payload: signupPayload({ admin: { password: "short" } }),
  });
  assert.equal(res.statusCode, 400);
});

test("password over 72 bytes returns 400", async () => {
  const res = await send(getApp(), {
    method: "POST",
    url: "/tenants",
    payload: signupPayload({ admin: { password: "é".repeat(40) } }),
  });
  assert.equal(res.statusCode, 400);
});

test("invalid email returns 400", async () => {
  const res = await send(getApp(), {
    method: "POST",
    url: "/tenants",
    payload: signupPayload({ admin: { email: "not-an-email" } }),
  });
  assert.equal(res.statusCode, 400);
});

test("unknown body fields return 400", async () => {
  const top = await send(getApp(), {
    method: "POST",
    url: "/tenants",
    payload: { ...signupPayload(), extra: 1 },
  });
  assert.equal(top.statusCode, 400);

  const nested = await send(getApp(), {
    method: "POST",
    url: "/tenants",
    payload: signupPayload({ admin: { role: "admin" } }),
  });
  assert.equal(nested.statusCode, 400);
});
