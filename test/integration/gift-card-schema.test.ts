import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { adminQuery, getAppDataSource, resetDb, setupDatabase, teardownDatabase } from "./helpers";

// Runs as the least-privileged app role: the constraints and triggers must hold for it, and the
// grants must be enough for the later services.
const app = () => getAppDataSource();

before(async () => {
  await setupDatabase();
});
beforeEach(async () => {
  await resetDb();
});
after(async () => {
  await teardownDatabase();
});

// PostgreSQL error codes
const FOREIGN_KEY_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";
const RESTRICT_VIOLATION = "23001";

/** Expects a statement to fail with the given SQLSTATE (and constraint name, when given). */
async function rejectsWith(statement: Promise<unknown>, code: string, constraint?: string): Promise<void> {
  await assert.rejects(statement, (err: { driverError?: { code?: string; constraint?: string } }) => {
    assert.equal(err.driverError?.code, code);
    if (constraint !== undefined) assert.equal(err.driverError?.constraint, constraint);
    return true;
  });
}

interface Fixture {
  tenantId: string;
  userId: string;
  programId: string;
  cardId: string;
}

let sequence = 0;

async function insertTenant(subdomain: string): Promise<{ tenantId: string; userId: string }> {
  const [tenant] = await app().query<{ id: string }[]>(`INSERT INTO tenants (name, subdomain) VALUES ($1, $1) RETURNING id`, [
    subdomain,
  ]);
  const [user] = await app().query<{ id: string }[]>(
    `INSERT INTO users (tenant_id, name, email, password_hash) VALUES ($1, 'U', $2, 'x') RETURNING id`,
    [tenant.id, `${subdomain}@schema.example`]
  );
  return { tenantId: tenant.id, userId: user.id };
}

async function insertProgram(tenantId: string, currency = "CAD"): Promise<string> {
  const [program] = await app().query<{ id: string }[]>(
    `INSERT INTO gift_card_programs (tenant_id, name, card_type, currency, country, card_number_prefix,
        card_number_length, pin_required, max_value)
     VALUES ($1, $2, 'paid', $3, 'CA', '7000', 19, false, 100000) RETURNING id`,
    [tenantId, `Program ${++sequence}`, currency]
  );
  return program.id;
}

function insertCard(
  o: { tenantId: string; programId: string; userId: string },
  over: { currency?: string; status?: string; balance?: number; initialAmount?: number } = {}
): Promise<unknown> {
  const n = String(++sequence).padStart(4, "0");
  return app().query(
    `INSERT INTO gift_cards (tenant_id, program_id, currency, reference_number, card_number_enc,
        card_number_hmac, card_number_last4, encryption_key_id, lookup_key_id, initial_amount, balance,
        status, issued_by)
     VALUES ($1, $2, $3, $4, $5, $6, '1234', 1, 1, $7, $8, $9, $10) RETURNING id`,
    [
      o.tenantId,
      o.programId,
      over.currency ?? "CAD",
      `00000000${n}`,
      Buffer.from("ciphertext"),
      randomBytes(32),
      over.initialAmount ?? 1000,
      over.balance ?? 1000,
      over.status ?? "active",
      o.userId,
    ]
  );
}

async function createFixture(subdomain: string): Promise<Fixture> {
  const { tenantId, userId } = await insertTenant(subdomain);
  const programId = await insertProgram(tenantId);
  const [card] = (await insertCard({ tenantId, programId, userId })) as { id: string }[];
  return { tenantId, userId, programId, cardId: card.id };
}

function insertTransaction(o: {
  tenantId: string;
  cardId: string;
  userId: string;
  currency?: string;
  type?: string;
  relatedTransactionId?: string;
}): Promise<unknown> {
  const type = o.type ?? "issue";
  return app().query(
    `INSERT INTO gift_card_transactions (tenant_id, gift_card_id, currency, type, amount, balance_after,
        related_transaction_id, idempotency_key, request_hash, actor_user_id)
     VALUES ($1, $2, $3, $4, 100, 900, $5, $6, $7, $8) RETURNING id`,
    [
      o.tenantId,
      o.cardId,
      o.currency ?? "CAD",
      type,
      o.relatedTransactionId ?? null,
      `key-${++sequence}`,
      randomBytes(32),
      o.userId,
    ]
  );
}

function insertDelivery(o: { tenantId: string; cardId: string; userId: string }): Promise<unknown> {
  return app().query(
    `INSERT INTO gift_card_deliveries (tenant_id, gift_card_id, recipient_name, recipient_email, sender_name,
        send_at, next_attempt_at, created_by)
     VALUES ($1, $2, 'R', 'r@schema.example', 'S', now(), now(), $3) RETURNING id`,
    [o.tenantId, o.cardId, o.userId]
  );
}

test("card with another tenant's program rejected by FK", async () => {
  const a = await createFixture("tenant-a");
  const b = await insertTenant("tenant-b");
  await rejectsWith(
    insertCard({ tenantId: b.tenantId, programId: a.programId, userId: b.userId }),
    FOREIGN_KEY_VIOLATION,
    "gift_cards_program_fkey"
  );
  // Control: the same tenant's own program is accepted
  const ownProgram = await insertProgram(b.tenantId);
  await insertCard({ tenantId: b.tenantId, programId: ownProgram, userId: b.userId });
});

test("card currency differs from program rejected", async () => {
  const { tenantId, userId, programId } = await createFixture("tenant-a");
  await rejectsWith(
    insertCard({ tenantId, programId, userId }, { currency: "USD" }),
    FOREIGN_KEY_VIOLATION,
    "gift_cards_program_fkey"
  );
});

test("ledger row with another tenant or currency rejected", async () => {
  const a = await createFixture("tenant-a");
  const b = await insertTenant("tenant-b");
  await rejectsWith(
    insertTransaction({ tenantId: b.tenantId, cardId: a.cardId, userId: b.userId }),
    FOREIGN_KEY_VIOLATION,
    "gift_card_transactions_card_fkey"
  );
  await rejectsWith(
    insertTransaction({ tenantId: a.tenantId, cardId: a.cardId, userId: a.userId, currency: "USD" }),
    FOREIGN_KEY_VIOLATION,
    "gift_card_transactions_card_fkey"
  );
  // Control: the card's own tenant and currency are accepted
  await insertTransaction({ tenantId: a.tenantId, cardId: a.cardId, userId: a.userId });
});

test("delivery for another tenant's card rejected", async () => {
  const a = await createFixture("tenant-a");
  const b = await insertTenant("tenant-b");
  await rejectsWith(
    insertDelivery({ tenantId: b.tenantId, cardId: a.cardId, userId: b.userId }),
    FOREIGN_KEY_VIOLATION,
    "gift_card_deliveries_card_fkey"
  );
  // Control
  await insertDelivery({ tenantId: a.tenantId, cardId: a.cardId, userId: a.userId });
});

test("refund pointing at another card's transaction rejected", async () => {
  const a = await createFixture("tenant-a");
  const secondProgram = await insertProgram(a.tenantId);
  const [other] = (await insertCard({ tenantId: a.tenantId, programId: secondProgram, userId: a.userId })) as {
    id: string;
  }[];
  const [issued] = (await insertTransaction({ tenantId: a.tenantId, cardId: a.cardId, userId: a.userId })) as {
    id: string;
  }[];
  const [otherIssued] = (await insertTransaction({ tenantId: a.tenantId, cardId: other.id, userId: a.userId })) as {
    id: string;
  }[];

  await rejectsWith(
    insertTransaction({
      tenantId: a.tenantId,
      cardId: other.id,
      userId: a.userId,
      type: "refund",
      relatedTransactionId: issued.id,
    }),
    FOREIGN_KEY_VIOLATION,
    "gift_card_transactions_related_fkey"
  );
  // Control: a refund pointing at a transaction of its own card is accepted
  await insertTransaction({
    tenantId: a.tenantId,
    cardId: other.id,
    userId: a.userId,
    type: "refund",
    relatedTransactionId: otherIssued.id,
  });
});

test("ledger UPDATE/DELETE rejected by trigger as the app role", async () => {
  const a = await createFixture("tenant-a");
  const [row] = (await insertTransaction({ tenantId: a.tenantId, cardId: a.cardId, userId: a.userId })) as {
    id: string;
  }[];
  await rejectsWith(
    app().query(`UPDATE gift_card_transactions SET amount = 1 WHERE id = $1`, [row.id]),
    RESTRICT_VIOLATION
  );
  await rejectsWith(app().query(`DELETE FROM gift_card_transactions WHERE id = $1`, [row.id]), RESTRICT_VIOLATION);
  const after = await app().query<{ amount: number }[]>(
    `SELECT amount FROM gift_card_transactions WHERE id = $1`,
    [row.id]
  );
  assert.deepEqual(after, [{ amount: 100 }]);
});

test("audit_logs UPDATE/DELETE rejected", async () => {
  const a = await createFixture("tenant-a");
  const [row] = await app().query<{ id: string }[]>(
    `INSERT INTO audit_logs (tenant_id, user_id, action, details) VALUES ($1, $2, 'schema.test', '{"k":1}') RETURNING id`,
    [a.tenantId, a.userId]
  );

  await rejectsWith(app().query(`UPDATE audit_logs SET action = 'x' WHERE id = $1`, [row.id]), RESTRICT_VIOLATION);
  await rejectsWith(app().query(`DELETE FROM audit_logs WHERE id = $1`, [row.id]), RESTRICT_VIOLATION);
  // The schema-owning role is bound by the trigger too
  await assert.rejects(adminQuery(`UPDATE audit_logs SET action = 'x' WHERE id = $1`, [row.id]), /audit_logs is append-only/);
  await assert.rejects(adminQuery(`DELETE FROM audit_logs WHERE id = $1`, [row.id]), /audit_logs is append-only/);

  const after = await app().query<{ action: string }[]>(`SELECT action FROM audit_logs WHERE id = $1`, [row.id]);
  assert.deepEqual(after, [{ action: "schema.test" }]);
});

test("active with balance 0 rejected", async () => {
  const { tenantId, userId, programId, cardId } = await createFixture("tenant-a");
  await rejectsWith(
    insertCard({ tenantId, programId, userId }, { status: "active", balance: 0 }),
    CHECK_VIOLATION,
    "gift_cards_status_balance_check"
  );
  await rejectsWith(
    app().query(`UPDATE gift_cards SET balance = 0 WHERE id = $1`, [cardId]),
    CHECK_VIOLATION,
    "gift_cards_status_balance_check"
  );
  // Control: depleted with balance 0 is the valid state
  await insertCard({ tenantId, programId, userId }, { status: "depleted", balance: 0 });
});

test("program currency update with cards rejected by FK", async () => {
  const { tenantId, programId } = await createFixture("tenant-a");
  await rejectsWith(
    app().query(`UPDATE gift_card_programs SET currency = 'USD' WHERE id = $1`, [programId]),
    FOREIGN_KEY_VIOLATION,
    "gift_cards_program_fkey"
  );
  // Control: a program with no cards can change currency
  const empty = await insertProgram(tenantId);
  await app().query(`UPDATE gift_card_programs SET currency = 'USD' WHERE id = $1`, [empty]);
});

// The migrations' VERIFY steps, asserted so later phases can rely on these names.
test("VERIFY: constraint and index names, triggers and app-role privileges", async () => {
  const expectedConstraints: Record<string, string[]> = {
    gift_card_programs: [
      "gift_card_programs_tenant_id_fkey",
      "gift_card_programs_tenant_id_name_key",
      "gift_card_programs_id_tenant_id_currency_key",
      "gift_card_programs_card_type_check",
      "gift_card_programs_status_check",
      "gift_card_programs_currency_check",
      "gift_card_programs_country_check",
      "gift_card_programs_region_check",
      "gift_card_programs_prefix_check",
      "gift_card_programs_length_check",
      "gift_card_programs_pinless_length_check",
      "gift_card_programs_max_value_check",
      "gift_card_programs_expiry_check",
      "gift_card_programs_staff_limit_check",
    ],
    gift_cards: [
      "gift_cards_tenant_id_fkey",
      "gift_cards_program_fkey",
      "gift_cards_issued_by_fkey",
      "gift_cards_card_number_hmac_key",
      "gift_cards_tenant_id_reference_number_key",
      "gift_cards_id_tenant_id_key",
      "gift_cards_id_tenant_id_currency_key",
      "gift_cards_status_check",
      "gift_cards_balance_check",
      "gift_cards_initial_amount_check",
      "gift_cards_status_balance_check",
      "gift_cards_hmac_length_check",
      "gift_cards_last4_check",
      "gift_cards_reference_check",
      "gift_cards_pin_attempts_check",
      "gift_cards_pinless_lockout_check",
    ],
    gift_card_transactions: [
      "gift_card_transactions_card_fkey",
      "gift_card_transactions_actor_fkey",
      "gift_card_transactions_tenant_id_idempotency_key_key",
      "gift_card_transactions_id_gift_card_id_key",
      "gift_card_transactions_related_fkey",
      "gift_card_transactions_type_check",
      "gift_card_transactions_amount_check",
      "gift_card_transactions_balance_after_check",
      "gift_card_transactions_related_check",
      "gift_card_transactions_idempotency_check",
    ],
    gift_card_deliveries: [
      "gift_card_deliveries_gift_card_id_key",
      "gift_card_deliveries_token_hash_key",
      "gift_card_deliveries_card_fkey",
      "gift_card_deliveries_created_by_fkey",
      "gift_card_deliveries_status_check",
      "gift_card_deliveries_attempts_check",
      "gift_card_deliveries_reveal_count_check",
      "gift_card_deliveries_token_pair_check",
      "gift_card_deliveries_token_hash_length_check",
      "gift_card_deliveries_claimed_check",
      "gift_card_deliveries_cancelled_token_check",
    ],
    gift_card_key_checks: [
      "gift_card_key_checks_pkey",
      "gift_card_key_checks_purpose_check",
      "gift_card_key_checks_length_check",
    ],
  };
  for (const [table, names] of Object.entries(expectedConstraints)) {
    const rows = await app().query<{ conname: string }[]>(
      `SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype IN ('p', 'u', 'f', 'c')`,
      [table]
    );
    const actual = new Set(rows.map((r) => r.conname));
    for (const name of names) assert.ok(actual.has(name), `${table} has constraint ${name}`);
    // A primary key is named <table>_pkey; nothing else unnamed has been added
    assert.deepEqual(
      [...actual].filter((n) => !names.includes(n) && n !== `${table}_pkey`),
      [],
      `${table} has no unexpected constraints`
    );
  }

  const indexes = await app().query<{ indexname: string }[]>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1)`,
    [
      [
        "gift_cards_program_id_idx",
        "gift_card_transactions_gift_card_id_created_at_idx",
        "gift_card_transactions_related_transaction_id_idx",
        "gift_card_transactions_actor_user_id_created_at_idx",
        "gift_card_deliveries_due_idx",
        "audit_logs_tenant_id_idx",
        "audit_logs_user_id_idx",
      ],
    ]
  );
  assert.equal(indexes.length, 7);

  const triggers = await app().query<{ table_name: string; tgname: string }[]>(
    `SELECT tgrelid::regclass::text AS table_name, tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2`
  );
  assert.deepEqual(triggers, [
    { table_name: "audit_logs", tgname: "audit_logs_no_update_delete" },
    { table_name: "gift_card_transactions", tgname: "gift_card_transactions_no_update_delete" },
  ]);

  const grants = await app().query<{ table_name: string; privileges: string[] }[]>(
    `SELECT table_name, array_agg(privilege_type::text ORDER BY privilege_type::text) AS privileges
       FROM information_schema.table_privileges
      WHERE grantee = current_user AND table_schema = 'public' AND table_name LIKE 'gift_card%'
      GROUP BY table_name ORDER BY table_name`
  );
  const all = ["DELETE", "INSERT", "SELECT", "UPDATE"];
  assert.deepEqual(
    grants.map((g) => g.table_name),
    ["gift_card_deliveries", "gift_card_key_checks", "gift_card_programs", "gift_card_transactions", "gift_cards"]
  );
  for (const g of grants) assert.deepEqual(g.privileges, all, g.table_name);

  // The legacy tables and enums are gone
  const legacy = await app().query<{ transactions: string | null; enums: number }[]>(
    `SELECT to_regclass('public.transactions')::text AS transactions,
            (SELECT count(*)::int FROM pg_type WHERE typname IN ('transaction_type', 'gift_card_status')) AS enums`
  );
  assert.deepEqual(legacy, [{ transactions: null, enums: 0 }]);
});
