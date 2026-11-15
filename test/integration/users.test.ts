import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PASSWORD,
  UUID_V7,
  bearer,
  login,
  send,
  signupTenant,
  useTestApp,
  type UserDto,
} from "./helpers";

const getApp = useTestApp();

test("admin creates a staff user in their own tenant", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.example");
  const { accessToken } = await login(getApp(), s.email);

  const res = await send(getApp(), {
    method: "POST",
    url: "/users",
    headers: bearer(accessToken),
    payload: { name: "Sam", email: "Sam@Acme.example", password: PASSWORD },
  });
  assert.equal(res.statusCode, 201);
  const user = res.json<UserDto>();
  assert.equal(user.role, "staff");
  assert.equal(user.email, "sam@acme.example");
  assert.equal(user.tenantId, s.tenantId);
  assert.match(user.id, UUID_V7);
  assert.match(user.tenantId, UUID_V7);

  // the invited user can log in
  const staff = await login(getApp(), "sam@acme.example");
  assert.ok(staff.accessToken);
});

test("admin can create another admin", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.example");
  const { accessToken } = await login(getApp(), s.email);
  const res = await send(getApp(), {
    method: "POST",
    url: "/users",
    headers: bearer(accessToken),
    payload: { name: "Bo", email: "bo@acme.example", password: PASSWORD, role: "admin" },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json<UserDto>().role, "admin");
});

test("the tenant can not be chosen via the body", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.example");
  const other = await signupTenant(getApp(), "other", "owner@other.example");
  const { accessToken } = await login(getApp(), s.email);
  const res = await send(getApp(), {
    method: "POST",
    url: "/users",
    headers: bearer(accessToken),
    payload: { name: "Sam", email: "sam@acme.example", password: PASSWORD, tenantId: other.tenantId },
  });
  assert.equal(res.statusCode, 400);
});

test("creating a user with an existing email returns 409", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.example");
  const { accessToken } = await login(getApp(), s.email);
  const res = await send(getApp(), {
    method: "POST",
    url: "/users",
    headers: bearer(accessToken),
    payload: { name: "Dup", email: "ADA@acme.example", password: PASSWORD },
  });
  assert.equal(res.statusCode, 409);
});

test("invalid role returns 400", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.example");
  const { accessToken } = await login(getApp(), s.email);
  const res = await send(getApp(), {
    method: "POST",
    url: "/users",
    headers: bearer(accessToken),
    payload: { name: "X", email: "x@acme.example", password: PASSWORD, role: "superuser" },
  });
  assert.equal(res.statusCode, 400);
});

test("staff can not create or list users (403) but can read their profile", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.example");
  const admin = await login(getApp(), s.email);
  await send(getApp(), {
    method: "POST",
    url: "/users",
    headers: bearer(admin.accessToken),
    payload: { name: "Sam", email: "sam@acme.example", password: PASSWORD },
  });
  const staff = await login(getApp(), "sam@acme.example");

  const create = await send(getApp(), {
    method: "POST",
    url: "/users",
    headers: bearer(staff.accessToken),
    payload: { name: "Eve", email: "eve@acme.example", password: PASSWORD },
  });
  assert.equal(create.statusCode, 403);

  const list = await send(getApp(), {
    method: "GET",
    url: "/users",
    headers: bearer(staff.accessToken),
  });
  assert.equal(list.statusCode, 403);

  const me = await send(getApp(), {
    method: "GET",
    url: "/users/me",
    headers: bearer(staff.accessToken),
  });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json<UserDto>().role, "staff");
});

test("GET /users lists only the caller's tenant, ordered by creation time", async () => {
  const a = await signupTenant(getApp(), "acme", "ada@acme.example");
  const b = await signupTenant(getApp(), "bravo", "bea@bravo.example");
  const adminA = await login(getApp(), a.email);
  const adminB = await login(getApp(), b.email);

  await send(getApp(), {
    method: "POST",
    url: "/users",
    headers: bearer(adminA.accessToken),
    payload: { name: "A2", email: "a2@acme.example", password: PASSWORD },
  });
  await send(getApp(), {
    method: "POST",
    url: "/users",
    headers: bearer(adminB.accessToken),
    payload: { name: "B2", email: "b2@bravo.example", password: PASSWORD },
  });

  const listA = await send(getApp(), {
    method: "GET",
    url: "/users",
    headers: bearer(adminA.accessToken),
  });
  const listB = await send(getApp(), {
    method: "GET",
    url: "/users",
    headers: bearer(adminB.accessToken),
  });
  assert.equal(listA.statusCode, 200);
  assert.deepEqual(
    listA.json<UserDto[]>().map((u) => u.email),
    ["ada@acme.example", "a2@acme.example"]
  );
  assert.deepEqual(
    listB.json<UserDto[]>().map((u) => u.email),
    ["bea@bravo.example", "b2@bravo.example"]
  );
  // UUIDv7 ids are time-ordered, so creation order is also id order
  const ids = listA.json<UserDto[]>().map((u) => u.id);
  assert.deepEqual(ids, [...ids].sort());
});

test("a token can not reach another tenant's user", async () => {
  const a = await signupTenant(getApp(), "acme", "ada@acme.example");
  const b = await signupTenant(getApp(), "bravo", "bea@bravo.example");

  // Each admin sees only their own profile
  const adminB = await login(getApp(), b.email);
  const me = await send(getApp(), {
    method: "GET",
    url: "/users/me",
    headers: bearer(adminB.accessToken),
  });
  assert.equal(me.json<UserDto>().id, b.adminId);

  // A validly signed token pairing A's user id with B's tenant id resolves to nothing:
  // lookups are always scoped by tenant, so the id alone grants no access.
  const forged = getApp().jwt.sign({
    sub: a.adminId,
    tid: b.tenantId,
    role: "admin" as never,
    typ: "access",
  });
  const res = await send(getApp(), { method: "GET", url: "/users/me", headers: bearer(forged) });
  assert.equal(res.statusCode, 404);

  // B's admin creating a user never lands in A's tenant
  await send(getApp(), {
    method: "POST",
    url: "/users",
    headers: bearer(adminB.accessToken),
    payload: { name: "B2", email: "b2@bravo.example", password: PASSWORD },
  });
  const adminA = await login(getApp(), a.email);
  const listA = await send(getApp(), { method: "GET", url: "/users", headers: bearer(adminA.accessToken) });
  assert.deepEqual(listA.json<UserDto[]>().map((u) => u.email), ["ada@acme.example"]);
});

test("wrong-typed body fields are rejected, not coerced", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.example");
  const { accessToken } = await login(getApp(), s.email);
  const base = { name: "Sam", email: "sam@acme.example", password: PASSWORD };

  for (const override of [{ password: 12345678 }, { email: ["sam@acme.example"] }]) {
    const res = await send(getApp(), {
      method: "POST",
      url: "/users",
      headers: bearer(accessToken),
      payload: { ...base, ...override },
    });
    assert.equal(res.statusCode, 400, JSON.stringify(override));
  }
});

test("authentication and role checks run before body validation", async () => {
  const s = await signupTenant(getApp(), "acme", "ada@acme.example");
  const admin = await login(getApp(), s.email);
  await send(getApp(), {
    method: "POST",
    url: "/users",
    headers: bearer(admin.accessToken),
    payload: { name: "Sam", email: "sam@acme.example", password: PASSWORD },
  });
  const staff = await login(getApp(), "sam@acme.example");
  const invalid = { name: "" };

  const anonymous = await send(getApp(), { method: "POST", url: "/users", payload: invalid });
  assert.equal(anonymous.statusCode, 401);

  const asStaff = await send(getApp(), {
    method: "POST",
    url: "/users",
    headers: bearer(staff.accessToken),
    payload: invalid,
  });
  assert.equal(asStaff.statusCode, 403);

  const asAdmin = await send(getApp(), {
    method: "POST",
    url: "/users",
    headers: bearer(admin.accessToken),
    payload: invalid,
  });
  assert.equal(asAdmin.statusCode, 400);
});
