// Integration helpers. Importing this module points the app at the test database
// BEFORE any src/ module (and therefore src/config.ts) is loaded, so keep the
// src imports below lazy (require) and never import src/ at the top of this file
// or of an integration test file.

// Must stay the first import: loads .env (without overriding vars already set in the shell)
// so the DB name below is derived from the same value src/config.ts would see.
import "dotenv/config";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach } from "node:test";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import type { DataSource } from "typeorm";
import { assertTestDatabase, resolveTestDatabase } from "../support/test-db";

const testDb = resolveTestDatabase(process.env);
assertTestDatabase(testDb, process.env);
process.env.DB_DATABASE = testDb;

interface Loaded {
  admin: DataSource;
  app: DataSource;
  buildApp: typeof import("../../src/app").buildApp;
}

let loaded: Loaded | undefined;

function load(): Loaded {
  if (!loaded) {
    // Lazy require on purpose: src/ must load only after DB_DATABASE is switched (see file header)
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy, see above
    const migrationDs = require("../../src/migration-data-source") as typeof import("../../src/migration-data-source");
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy, see above
    const appDs = require("../../src/data-source") as typeof import("../../src/data-source");
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy, see above
    const appModule = require("../../src/app") as typeof import("../../src/app");
    loaded = { admin: migrationDs.default, app: appDs.AppDataSource, buildApp: appModule.buildApp };
  }
  return loaded;
}

/** Connects both data sources and applies pending migrations as the admin role. */
export async function setupDatabase(): Promise<void> {
  const { admin, app } = load();
  assertTestDatabase(admin.options.database as string | undefined, process.env);
  if (!admin.isInitialized) await admin.initialize();
  await admin.runMigrations();
  if (!app.isInitialized) await app.initialize();
}

export async function teardownDatabase(): Promise<void> {
  const { admin, app } = load();
  if (app.isInitialized) await app.destroy();
  if (admin.isInitialized) await admin.destroy();
}

/** Builds the Fastify app on the (initialized) app data source, running as the app role. */
export async function buildTestApp(): Promise<FastifyInstance> {
  const { app, buildApp } = load();
  if (!app.isInitialized) await setupDatabase();
  return buildApp({ dataSource: app, logger: false });
}

/** Runs SQL as the admin role (fixtures and direct state changes). */
export async function adminQuery(sql: string, params: unknown[] = []): Promise<unknown> {
  const { admin } = load();
  if (!admin.isInitialized) await admin.initialize();
  return admin.query(sql, params);
}

/** Empties every table except the migrations table, using admin creds. */
export async function resetDb(): Promise<void> {
  const { admin } = load();
  if (!admin.isInitialized) await admin.initialize();
  // Belt and braces: check the database we are actually connected to, not the config
  const [{ db }]: { db: string }[] = await admin.query("SELECT current_database() AS db");
  assertTestDatabase(db, process.env);

  const migrationsTable = admin.options.migrationsTableName ?? "migrations";
  const rows: { tablename: string }[] = await admin.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> $1`,
    [migrationsTable]
  );
  if (rows.length === 0) return;
  const tables = rows.map((r) => `"${r.tablename}"`).join(", ");
  await admin.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}

const FORBIDDEN_IN_RESPONSES = ["passwordHash", "password_hash", "$2b$"];

/** app.inject that also fails the test if the response could leak a password hash. */
export async function send(
  app: FastifyInstance,
  opts: InjectOptions
): Promise<LightMyRequestResponse> {
  const res = await app.inject(opts);
  for (const needle of FORBIDDEN_IN_RESPONSES) {
    assert.ok(!res.body.includes(needle), `response body must not contain "${needle}"`);
  }
  return res;
}

export interface SignupResult {
  tenantId: number;
  adminId: number;
  email: string;
  password: string;
}

export const PASSWORD = "correct-horse-battery";

export async function signupTenant(
  app: FastifyInstance,
  subdomain: string,
  email: string
): Promise<SignupResult> {
  const res = await send(app, {
    method: "POST",
    url: "/tenants",
    payload: {
      tenant: { name: `Tenant ${subdomain}`, subdomain },
      admin: { name: "Admin", email, password: PASSWORD },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json<{ tenant: TenantDto; user: UserDto }>();
  return {
    tenantId: body.tenant.id,
    adminId: body.user.id,
    email: email.trim().toLowerCase(),
    password: PASSWORD,
  };
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export async function login(
  app: FastifyInstance,
  email: string,
  password = PASSWORD
): Promise<Tokens> {
  const res = await send(app, { method: "POST", url: "/auth/login", payload: { email, password } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json<Tokens>();
}

export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/**
 * Registers the standard lifecycle for an integration test file: migrate once, reset data
 * and build a fresh app (fresh rate-limit counters) for every test, tear down at the end.
 * Call at the top level of the test file; returns an accessor for the current app.
 */
export function useTestApp(): () => FastifyInstance {
  let app: FastifyInstance | undefined;

  before(async () => {
    await setupDatabase();
  });
  beforeEach(async () => {
    await resetDb();
    app = await buildTestApp();
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });
  after(async () => {
    await teardownDatabase();
  });

  return () => {
    assert.ok(app, "app is only available inside a test");
    return app;
  };
}

export interface UserDto {
  id: number;
  tenantId: number;
  name: string;
  email: string;
  role: string;
}

export interface TenantDto {
  id: number;
  name: string;
  subdomain: string;
}
