import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  PASSWORD,
  UUID_V7,
  adminQuery,
  bearer,
  login,
  send,
  signupTenant,
  useTestApp,
  type SignupResult,
} from "./helpers";

const getApp = useTestApp();

const PROGRAM_KEYS = [
  "id",
  "name",
  "cardType",
  "currency",
  "currencyExponent",
  "country",
  "region",
  "cardNumberPrefix",
  "cardNumberLength",
  "pinRequired",
  "maxValue",
  "expiryMonths",
  "staffDailyIssueLimit",
  "status",
  "hasIssuedCards",
  "createdAt",
  "updatedAt",
].sort();

interface ProgramDto {
  id: string;
  name: string;
  cardType: string;
  currency: string;
  currencyExponent: number;
  country: string;
  region: string | null;
  cardNumberPrefix: string;
  cardNumberLength: number;
  pinRequired: boolean;
  maxValue: number;
  expiryMonths: number | null;
  staffDailyIssueLimit: number | null;
  status: string;
  hasIssuedCards: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AuditRow {
  tenant_id: string | null;
  user_id: string | null;
  action: string;
  details: { programId: string; changes?: { field: string; from: unknown; to: unknown }[] };
}

type Headers = { authorization: string };

const validProgram = {
  name: "Holiday",
  cardType: "paid",
  currency: "CAD",
  country: "CA",
  cardNumberPrefix: "7000",
  cardNumberLength: 16,
  pinRequired: true,
  maxValue: 100000,
};

interface Actor {
  signup: SignupResult;
  admin: Headers;
  staff: Headers;
}

async function setupTenant(subdomain: string, email: string): Promise<Actor> {
  const signup = await signupTenant(getApp(), subdomain, email);
  const admin = bearer((await login(getApp(), signup.email)).accessToken);
  const staffEmail = `staff@${subdomain}.com`;
  const created = await send(getApp(), {
    method: "POST",
    url: "/users",
    headers: admin,
    payload: { name: "Sam", email: staffEmail, password: PASSWORD },
  });
  assert.equal(created.statusCode, 201, created.body);
  const staff = bearer((await login(getApp(), staffEmail)).accessToken);
  return { signup, admin, staff };
}

async function createProgram(headers: Headers, overrides: Record<string, unknown> = {}): Promise<ProgramDto> {
  const res = await post(headers, { ...validProgram, ...overrides });
  assert.equal(res.statusCode, 201, res.body);
  return res.json<ProgramDto>();
}

function post(headers: Headers, payload: Record<string, unknown>) {
  return send(getApp(), { method: "POST", url: "/gift-card-programs", headers, payload });
}

function patch(headers: Headers, id: string, payload: Record<string, unknown>) {
  return send(getApp(), { method: "PATCH", url: `/gift-card-programs/${id}`, headers, payload });
}

async function getProgram(headers: Headers, id: string): Promise<ProgramDto> {
  const res = await send(getApp(), { method: "GET", url: `/gift-card-programs/${id}`, headers });
  assert.equal(res.statusCode, 200, res.body);
  return res.json<ProgramDto>();
}

async function audit(programId?: string): Promise<AuditRow[]> {
  const rows = (await adminQuery(
    `SELECT tenant_id, user_id, action, details FROM audit_logs
      WHERE action LIKE 'gift_card_program.%' ORDER BY created_at, id`
  )) as AuditRow[];
  return programId ? rows.filter((r) => r.details.programId === programId) : rows;
}

let cardSequence = 0;

/** Inserts a card row directly (issuance is not an endpoint yet). */
async function insertCard(tenantId: string, programId: string, userId: string, currency = "CAD"): Promise<void> {
  const reference = String(++cardSequence).padStart(12, "0");
  await adminQuery(
    `INSERT INTO gift_cards (tenant_id, program_id, currency, reference_number, card_number_enc,
        card_number_hmac, card_number_last4, encryption_key_id, lookup_key_id, initial_amount, balance,
        status, issued_by)
     VALUES ($1, $2, $3, $4, $5, $6, '1234', 1, 1, 1000, 1000, 'active', $7)`,
    [tenantId, programId, currency, reference, Buffer.from("ciphertext"), randomBytes(32), userId]
  );
}

// ---------- create ----------

test("admin creates a program: 201, exact response shape, tenant from the token, audit row", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const res = await post(a.admin, validProgram);
  assert.equal(res.statusCode, 201, res.body);
  const program = res.json<ProgramDto>();

  assert.deepEqual(Object.keys(program).sort(), PROGRAM_KEYS);
  assert.match(program.id, UUID_V7);
  assert.deepEqual(
    { ...program, id: undefined, createdAt: undefined, updatedAt: undefined },
    {
      ...validProgram,
      id: undefined,
      createdAt: undefined,
      updatedAt: undefined,
      currencyExponent: 2,
      region: null,
      expiryMonths: null,
      staffDailyIssueLimit: null,
      status: "active",
      hasIssuedCards: false,
    }
  );

  const [row] = (await adminQuery(`SELECT tenant_id FROM gift_card_programs WHERE id = $1`, [program.id])) as {
    tenant_id: string;
  }[];
  assert.equal(row.tenant_id, a.signup.tenantId);

  assert.deepEqual(await audit(), [
    {
      tenant_id: a.signup.tenantId,
      user_id: a.signup.adminId,
      action: "gift_card_program.created",
      details: { programId: program.id },
    },
  ]);
});

test("a KWD program reports currencyExponent 3; optional fields round-trip", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const program = await createProgram(a.admin, {
    name: "Kuwait promo",
    cardType: "promotional",
    currency: "KWD",
    country: "KW",
    region: "KW-KU",
    expiryMonths: 12,
  });
  assert.equal(program.currencyExponent, 3);
  assert.equal(program.region, "KW-KU");
  assert.equal(program.expiryMonths, 12);
});

test("the tenant can not be chosen via the body", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const other = await signupTenant(getApp(), "other", "owner@other.com");
  const res = await post(a.admin, { ...validProgram, tenantId: other.tenantId });
  assert.equal(res.statusCode, 400);
});

test("unknown body fields, missing fields and wrong types return 400", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  assert.equal((await post(a.admin, { ...validProgram, status: "retired" })).statusCode, 400);
  assert.equal((await post(a.admin, { ...validProgram, bogus: 1 })).statusCode, 400);
  const { maxValue: omitted, ...missing } = validProgram;
  assert.equal(omitted, 100000);
  assert.equal((await post(a.admin, missing)).statusCode, 400);
  assert.equal((await post(a.admin, { ...validProgram, maxValue: "100" })).statusCode, 400);
  assert.equal((await post(a.admin, { ...validProgram, name: "" })).statusCode, 400);
  assert.equal((await post(a.admin, { ...validProgram, name: "bad\u0007name" })).statusCode, 400);
  assert.equal((await audit()).length, 0);
});

test("staff cannot create; unauthenticated is 401", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const res = await post(a.staff, validProgram);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.json(), { error: "Insufficient permissions" });
  const anonymous = await send(getApp(), { method: "POST", url: "/gift-card-programs", payload: validProgram });
  assert.equal(anonymous.statusCode, 401);
  assert.equal((await audit()).length, 0);
});

test("program name is unique per tenant, but two tenants may share a name", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const b = await setupTenant("other", "owner@other.com");
  await createProgram(a.admin);
  const dup = await post(a.admin, validProgram);
  assert.equal(dup.statusCode, 409);
  assert.equal((await audit()).length, 1);
  await createProgram(b.admin);
});

test("network prefixes and prefixes outside 7-9 are rejected", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const bad = ["8100", "829", "81", "9792", "979200", "4000", "6011", "0123", "700", "7000000", "70a0"];
  for (const cardNumberPrefix of bad) {
    const res = await post(a.admin, { ...validProgram, cardNumberPrefix });
    assert.equal(res.statusCode, 400, `${cardNumberPrefix}: ${res.body}`);
  }
  // 9791 is next to a denied prefix but not on the list
  await createProgram(a.admin, { cardNumberPrefix: "9791" });
});

test("a PIN-less program must have 19-digit numbers; card length is 16 to 19", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const bad = await post(a.admin, { ...validProgram, pinRequired: false, cardNumberLength: 16 });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json<{ error: string }>().error, /19/);
  assert.equal((await post(a.admin, { ...validProgram, cardNumberLength: 15 })).statusCode, 400);
  assert.equal((await post(a.admin, { ...validProgram, cardNumberLength: 20 })).statusCode, 400);
  const ok = await createProgram(a.admin, { pinRequired: false, cardNumberLength: 19 });
  assert.equal(ok.pinRequired, false);
});

test("expiryMonths is for promotional programs only; staffDailyIssueLimit for paid only", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  assert.equal((await post(a.admin, { ...validProgram, expiryMonths: 6 })).statusCode, 400);
  const promoLimit = { ...validProgram, cardType: "promotional", staffDailyIssueLimit: 5000 };
  assert.equal((await post(a.admin, promoLimit)).statusCode, 400);
  const promo = { ...validProgram, cardType: "promotional" };
  assert.equal((await post(a.admin, { ...promo, expiryMonths: 0 })).statusCode, 400);
  assert.equal((await post(a.admin, { ...promo, expiryMonths: 121 })).statusCode, 400);
  assert.equal((await post(a.admin, { ...validProgram, staffDailyIssueLimit: 0 })).statusCode, 400);

  const promoOk = await createProgram(a.admin, { name: "Promo", cardType: "promotional", expiryMonths: 120 });
  assert.equal(promoOk.expiryMonths, 120);
  const paid = await createProgram(a.admin, { name: "Paid with limit", staffDailyIssueLimit: 5000 });
  assert.equal(paid.staffDailyIssueLimit, 5000);
});

test("unsupported currency or country and a region from another country are rejected", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  assert.equal((await post(a.admin, { ...validProgram, currency: "EUR" })).statusCode, 400);
  assert.equal((await post(a.admin, { ...validProgram, country: "US" })).statusCode, 400);
  assert.equal((await post(a.admin, { ...validProgram, region: "US-NY" })).statusCode, 400);
  assert.equal((await post(a.admin, { ...validProgram, region: "CA" })).statusCode, 400);
  assert.equal((await post(a.admin, { ...validProgram, region: "ca-on" })).statusCode, 400);
  assert.equal((await post(a.admin, { ...validProgram, maxValue: 0 })).statusCode, 400);
  assert.equal((await post(a.admin, { ...validProgram, maxValue: 2_000_000_001 })).statusCode, 400);
  const ok = await createProgram(a.admin, { region: "CA-ON" });
  assert.equal(ok.region, "CA-ON");
  const max = await createProgram(a.admin, { name: "Max", maxValue: 2_000_000_000 });
  assert.equal(max.maxValue, 2_000_000_000);
});

test("a rejected create writes neither a program nor an audit row", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  await post(a.admin, { ...validProgram, cardNumberPrefix: "8100" });
  const rows = (await adminQuery(`SELECT count(*)::int AS n FROM gift_card_programs`)) as { n: number }[];
  assert.equal(rows[0].n, 0);
  assert.equal((await audit()).length, 0);
});

// ---------- read ----------

test("admin and staff can list and get programs, in creation order", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const first = await createProgram(a.admin, { name: "First" });
  const second = await createProgram(a.admin, { name: "Second" });

  for (const headers of [a.admin, a.staff]) {
    const list = await send(getApp(), { method: "GET", url: "/gift-card-programs", headers });
    assert.equal(list.statusCode, 200);
    const programs = list.json<ProgramDto[]>();
    assert.deepEqual(
      programs.map((p) => p.id),
      [first.id, second.id]
    );
    for (const p of programs) assert.deepEqual(Object.keys(p).sort(), PROGRAM_KEYS);
    assert.deepEqual(await getProgram(headers, second.id), second);
  }
});

test("GET requires authentication; an unknown id is 404 and a malformed id is 400", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  assert.equal((await send(getApp(), { method: "GET", url: "/gift-card-programs" })).statusCode, 401);
  const unknown = await send(getApp(), {
    method: "GET",
    url: "/gift-card-programs/0197a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b",
    headers: a.admin,
  });
  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(unknown.json(), { error: "Program not found" });
  const malformed = await send(getApp(), { method: "GET", url: "/gift-card-programs/not-a-uuid", headers: a.admin });
  assert.equal(malformed.statusCode, 400);
  assert.equal((await patch(a.admin, "not-a-uuid", { name: "x" })).statusCode, 400);
});

test("hasIssuedCards turns true once a card exists", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const withCard = await createProgram(a.admin, { name: "With card" });
  const without = await createProgram(a.admin, { name: "Without card" });
  await insertCard(a.signup.tenantId, withCard.id, a.signup.adminId);

  const res = await send(getApp(), { method: "GET", url: "/gift-card-programs", headers: a.staff });
  const list = res.json<ProgramDto[]>();
  assert.deepEqual(Object.fromEntries(list.map((p) => [p.name, p.hasIssuedCards])), {
    "With card": true,
    "Without card": false,
  });
  assert.equal((await getProgram(a.admin, withCard.id)).hasIssuedCards, true);
  assert.equal((await getProgram(a.admin, without.id)).hasIssuedCards, false);
});

// ---------- tenant isolation ----------

test("another tenant's program is invisible: list, get and patch", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const b = await setupTenant("other", "owner@other.com");
  const program = await createProgram(a.admin);

  const list = await send(getApp(), { method: "GET", url: "/gift-card-programs", headers: b.admin });
  assert.deepEqual(list.json(), []);
  for (const headers of [b.admin, b.staff]) {
    const res = await send(getApp(), { method: "GET", url: `/gift-card-programs/${program.id}`, headers });
    assert.equal(res.statusCode, 404);
  }
  assert.equal((await patch(b.admin, program.id, { name: "Hijacked" })).statusCode, 404);

  const [row] = (await adminQuery(`SELECT name FROM gift_card_programs WHERE id = $1`, [program.id])) as {
    name: string;
  }[];
  assert.equal(row.name, "Holiday");
  assert.equal((await audit()).filter((r) => r.action === "gift_card_program.updated").length, 0);
});

// ---------- update ----------

test("patch: role checks, empty or no-op bodies and unknown fields", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const program = await createProgram(a.admin);

  assert.equal((await patch(a.staff, program.id, { name: "x" })).statusCode, 403);
  const anonymous = await send(getApp(), {
    method: "PATCH",
    url: `/gift-card-programs/${program.id}`,
    payload: { name: "x" },
  });
  assert.equal(anonymous.statusCode, 401);
  assert.equal((await patch(a.admin, program.id, {})).statusCode, 400);
  assert.equal((await patch(a.admin, program.id, { name: "Holiday" })).statusCode, 400);
  assert.equal((await patch(a.admin, program.id, { tenantId: a.signup.tenantId })).statusCode, 400);
  assert.equal((await patch(a.admin, program.id, { id: program.id })).statusCode, 400);
  assert.equal((await patch(a.admin, program.id, { status: "deleted" })).statusCode, 400);
  assert.equal((await audit(program.id)).length, 1); // only the create row
});

test("before the first card every definition field is editable", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const program = await createProgram(a.admin);

  const res = await patch(a.admin, program.id, {
    name: "Renamed",
    cardType: "promotional",
    currency: "KWD",
    country: "KW",
    region: "KW-KU",
    cardNumberPrefix: "9100",
    cardNumberLength: 17,
    pinRequired: true,
    maxValue: 50000,
    expiryMonths: 6,
  });
  assert.equal(res.statusCode, 200, res.body);
  const updated = res.json<ProgramDto>();
  assert.deepEqual(Object.keys(updated).sort(), PROGRAM_KEYS);
  assert.equal(updated.name, "Renamed");
  assert.equal(updated.cardType, "promotional");
  assert.equal(updated.currency, "KWD");
  assert.equal(updated.currencyExponent, 3);
  assert.equal(updated.cardNumberPrefix, "9100");
  assert.equal(updated.expiryMonths, 6);
  assert.equal(updated.hasIssuedCards, false);
  assert.ok(new Date(updated.updatedAt) >= new Date(program.updatedAt));
  assert.equal(updated.createdAt, program.createdAt);

  assert.deepEqual(await getProgram(a.admin, program.id), updated);
});

test("a patch is validated as a whole: results that break a rule are 400 and change nothing", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const program = await createProgram(a.admin, { staffDailyIssueLimit: 100 });

  // a paid program cannot gain an expiry, and cannot become promotional while a staff limit is set
  assert.equal((await patch(a.admin, program.id, { expiryMonths: 3 })).statusCode, 400);
  assert.equal((await patch(a.admin, program.id, { cardType: "promotional" })).statusCode, 400);
  // 16-digit numbers need a PIN
  assert.equal((await patch(a.admin, program.id, { pinRequired: false })).statusCode, 400);
  assert.equal((await patch(a.admin, program.id, { region: "US-NY" })).statusCode, 400);
  assert.equal((await patch(a.admin, program.id, { cardNumberPrefix: "8200" })).statusCode, 400);
  assert.equal((await patch(a.admin, program.id, { maxValue: 0 })).statusCode, 400);

  assert.deepEqual(await getProgram(a.admin, program.id), program);
  assert.equal((await audit(program.id)).length, 1);
});

test("each immutable field is rejected with 409 naming it once a card exists", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const program = await createProgram(a.admin, { region: "CA-ON" });
  await insertCard(a.signup.tenantId, program.id, a.signup.adminId);

  const attempts: Record<string, unknown>[] = [
    { cardType: "promotional" },
    { currency: "USD" },
    { country: "AE" },
    { region: null },
    { region: "CA-QC" },
    { cardNumberPrefix: "7001" },
    { cardNumberLength: 17 },
  ];
  for (const attempt of attempts) {
    const res = await patch(a.admin, program.id, attempt);
    assert.equal(res.statusCode, 409, `${JSON.stringify(attempt)}: ${res.body}`);
    const field = Object.keys(attempt)[0];
    assert.match(res.json<{ error: string }>().error, new RegExp(`\\b${field}\\b`));
  }

  // all of them together are all named
  const all = await patch(a.admin, program.id, {
    cardType: "promotional",
    currency: "USD",
    country: "AE",
    region: null,
    cardNumberPrefix: "7001",
    cardNumberLength: 17,
  });
  assert.equal(all.statusCode, 409);
  for (const field of ["cardType", "currency", "country", "region", "cardNumberPrefix", "cardNumberLength"]) {
    assert.match(all.json<{ error: string }>().error, new RegExp(`\\b${field}\\b`));
  }

  // an immutable field mixed with a mutable one: nothing is applied
  const mixed = await patch(a.admin, program.id, { name: "Mixed", currency: "USD" });
  assert.equal(mixed.statusCode, 409);
  assert.deepEqual(await getProgram(a.admin, program.id), { ...program, hasIssuedCards: true });
  assert.equal((await audit(program.id)).length, 1); // no audit rows from the rejected updates

  // re-sending the current value of an immutable field is not a change
  const same = await patch(a.admin, program.id, { currency: "CAD", name: "Same currency" });
  assert.equal(same.statusCode, 200, same.body);
  assert.equal(same.json<ProgramDto>().name, "Same currency");
});

test("an invalid value for an immutable field after a card exists is still a 409, not a 400", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const program = await createProgram(a.admin);
  await insertCard(a.signup.tenantId, program.id, a.signup.adminId);
  assert.equal((await patch(a.admin, program.id, { cardNumberPrefix: "8100" })).statusCode, 409);
});

test("mutable fields still change after a card exists; pinRequired and expiry apply to new cards only", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const paid = await createProgram(a.admin, { pinRequired: true, cardNumberLength: 19 });
  const promo = await createProgram(a.admin, { name: "Promo", cardType: "promotional", expiryMonths: 12 });
  await insertCard(a.signup.tenantId, paid.id, a.signup.adminId);
  await insertCard(a.signup.tenantId, promo.id, a.signup.adminId);

  const p1 = await patch(a.admin, paid.id, {
    name: "Paid v2",
    maxValue: 250000,
    staffDailyIssueLimit: 20000,
    pinRequired: false,
  });
  assert.equal(p1.statusCode, 200, p1.body);
  assert.deepEqual(
    { ...p1.json<ProgramDto>(), updatedAt: undefined },
    {
      ...paid,
      name: "Paid v2",
      maxValue: 250000,
      staffDailyIssueLimit: 20000,
      pinRequired: false,
      hasIssuedCards: true,
      updatedAt: undefined,
    }
  );

  const p2 = await patch(a.admin, promo.id, { expiryMonths: 24 });
  assert.equal(p2.json<ProgramDto>().expiryMonths, 24);
  const p3 = await patch(a.admin, promo.id, { expiryMonths: null });
  assert.equal(p3.json<ProgramDto>().expiryMonths, null);

  // the 19-digit rule still binds pinRequired on a program whose numbers are shorter
  const short = await createProgram(a.admin, { name: "Short", cardNumberLength: 16 });
  await insertCard(a.signup.tenantId, short.id, a.signup.adminId);
  assert.equal((await patch(a.admin, short.id, { pinRequired: false })).statusCode, 400);

  // existing cards are untouched: the three inserted cards still exist
  const cards = (await adminQuery(`SELECT count(*)::int AS n FROM gift_cards`)) as { n: number }[];
  assert.equal(cards[0].n, 3);
});

test("a program can be retired and reactivated; status changes are audited", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const program = await createProgram(a.admin);
  const retired = await patch(a.admin, program.id, { status: "retired" });
  assert.equal(retired.statusCode, 200);
  assert.equal(retired.json<ProgramDto>().status, "retired");

  const list = await send(getApp(), { method: "GET", url: "/gift-card-programs", headers: a.staff });
  assert.equal(list.json<ProgramDto[]>()[0].status, "retired");

  const back = await patch(a.admin, program.id, { status: "active" });
  assert.equal(back.json<ProgramDto>().status, "active");

  const rows = await audit(program.id);
  assert.deepEqual(
    rows.map((r) => [r.action, r.details.changes]),
    [
      ["gift_card_program.created", undefined],
      ["gift_card_program.updated", [{ field: "status", from: "active", to: "retired" }]],
      ["gift_card_program.updated", [{ field: "status", from: "retired", to: "active" }]],
    ]
  );
});

test("an update audit row records from and to for staffDailyIssueLimit, and only the changed fields", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  const program = await createProgram(a.admin);

  assert.equal((await patch(a.admin, program.id, { staffDailyIssueLimit: 5000 })).statusCode, 200);
  assert.equal((await patch(a.admin, program.id, { staffDailyIssueLimit: 8000, name: "Holiday 2" })).statusCode, 200);
  assert.equal((await patch(a.admin, program.id, { staffDailyIssueLimit: null })).statusCode, 200);
  assert.equal((await getProgram(a.admin, program.id)).staffDailyIssueLimit, null);

  const updates = (await audit(program.id)).filter((r) => r.action === "gift_card_program.updated");
  assert.equal(updates.length, 3);
  for (const u of updates) {
    assert.equal(u.tenant_id, a.signup.tenantId);
    assert.equal(u.user_id, a.signup.adminId);
  }
  assert.deepEqual(updates[0].details.changes, [{ field: "staffDailyIssueLimit", from: null, to: 5000 }]);
  assert.deepEqual(updates[1].details.changes, [
    { field: "name", from: "Holiday", to: "Holiday 2" },
    { field: "staffDailyIssueLimit", from: 5000, to: 8000 },
  ]);
  assert.deepEqual(updates[2].details.changes, [{ field: "staffDailyIssueLimit", from: 8000, to: null }]);
});

test("renaming onto an existing name in the tenant is 409 and leaves no audit row", async () => {
  const a = await setupTenant("acme", "ada@acme.com");
  await createProgram(a.admin, { name: "One" });
  const two = await createProgram(a.admin, { name: "Two" });
  const res = await patch(a.admin, two.id, { name: "One" });
  assert.equal(res.statusCode, 409);
  assert.equal((await audit(two.id)).length, 1);
});
