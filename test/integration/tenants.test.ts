import { mock, test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcrypt";
import {
  PASSWORD,
  UUID_V7,
  adminQuery,
  bearer,
  login,
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
    admin: { name: "Ada", email: "ada@acme.example", password: PASSWORD, ...overrides.admin },
  };
}

test("signup creates a tenant and its first admin", async () => {
  const res = await send(getApp(), { method: "POST", url: "/tenants", payload: signupPayload() });
  assert.equal(res.statusCode, 201);
  const body = res.json<{ tenant: TenantDto; user: UserDto }>();
  assert.equal(body.tenant.subdomain, "acme");
  assert.equal(body.user.email, "ada@acme.example");
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
    payload: signupPayload({ admin: { email: "  Ada@Acme.EXAMPLE " } }),
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json<{ user: UserDto }>().user.email, "ada@acme.example");
});

test("duplicate subdomain returns 409", async () => {
  await signupTenant(getApp(), "acme", "one@x.example");
  const res = await send(getApp(), {
    method: "POST",
    url: "/tenants",
    payload: signupPayload({ admin: { email: "two@x.example" } }),
  });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { error: "Subdomain already taken" });
});

test("duplicate email returns 409, case-insensitively, and creates no tenant", async () => {
  await signupTenant(getApp(), "first", "a@x.example");
  const res = await send(getApp(), {
    method: "POST",
    url: "/tenants",
    payload: signupPayload({ tenant: { subdomain: "second" }, admin: { email: "A@x.example" } }),
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

// Valid per RFC 5321 limits (64-char local part, 63-char labels), 196 characters in total
const LONG_EMAIL = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.com`;

test("a long but valid email is accepted for signup and for inviting a user", async () => {
  assert.ok(LONG_EMAIL.length > 150 && LONG_EMAIL.length <= 254);
  const res = await send(getApp(), {
    method: "POST",
    url: "/tenants",
    payload: signupPayload({ admin: { email: LONG_EMAIL } }),
  });
  assert.equal(res.statusCode, 201, res.body);

  const { accessToken } = await login(getApp(), LONG_EMAIL);
  const invite = await send(getApp(), {
    method: "POST",
    url: "/users",
    headers: bearer(accessToken),
    payload: { name: "Sam", email: LONG_EMAIL.replace("aaaa", "dddd"), password: PASSWORD },
  });
  assert.equal(invite.statusCode, 201, invite.body);
});

test("an email of 255 characters returns 400", async () => {
  const email = `${"a".repeat(255 - "@x.example".length)}@x.example`;
  assert.equal(email.length, 255);
  const res = await send(getApp(), {
    method: "POST",
    url: "/tenants",
    payload: signupPayload({ admin: { email } }),
  });
  assert.equal(res.statusCode, 400);
});

test("a signup that conflicts does not run bcrypt", async () => {
  await signupTenant(getApp(), "acme", "one@x.example");
  const hash = mock.method(bcrypt, "hash");
  try {
    const bySubdomain = await send(getApp(), {
      method: "POST",
      url: "/tenants",
      payload: signupPayload({ admin: { email: "two@x.example" } }),
    });
    const byEmail = await send(getApp(), {
      method: "POST",
      url: "/tenants",
      payload: signupPayload({ tenant: { subdomain: "other" }, admin: { email: "one@x.example" } }),
    });
    assert.equal(bySubdomain.statusCode, 409);
    assert.equal(byEmail.statusCode, 409);
    assert.equal(hash.mock.callCount(), 0);

    // Control: the spy does see a successful signup
    await signupTenant(getApp(), "third", "three@x.example");
    assert.equal(hash.mock.callCount(), 1);
  } finally {
    hash.mock.restore();
  }
});

test("signup is rate limited to 5 per minute", async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    const res = await send(getApp(), {
      method: "POST",
      url: "/tenants",
      payload: signupPayload({ tenant: { subdomain: `t${i}x` }, admin: { email: `u${i}@x.example` } }),
    });
    statuses.push(res.statusCode);
  }
  assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429]);
});

test("a numeric tenant name is rejected, not coerced to a string", async () => {
  const res = await send(getApp(), {
    method: "POST",
    url: "/tenants",
    payload: signupPayload({ tenant: { name: 12345 } }),
  });
  assert.equal(res.statusCode, 400);
});
