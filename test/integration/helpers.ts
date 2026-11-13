// Integration helpers. Builds an explicit test config that points at the test database
// (never the development one) and creates the data sources from it; process.env is not mutated.

// Must stay the first import: loads .env (without overriding vars already set in the shell)
// so the DB name below is derived from the same value an entry point would see.
import "dotenv/config";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach } from "node:test";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import type { DataSource } from "typeorm";
import { buildApp } from "../../src/app";
import { Config, PUBLISHED_NON_SECRET_KEYS, loadConfig } from "../../src/config";
import { createDataSource } from "../../src/data-source";
import { assertTestDatabase, resolveTestDatabase } from "../support/test-db";

// Config is loaded when this module is imported, on purpose: the suite cannot run without these
// variables, and the ConfigError raised here names whichever ones are missing.
const testDb = resolveTestDatabase(process.env);
assertTestDatabase(testDb, process.env);

// The only variables taken from the environment (after dotenv): connection credentials and the
// JWT secret. Everything else is fixed below so a shell with NODE_ENV=production, TRUST_PROXY=true
// or CORS_ORIGIN set cannot change what the tests exercise.
const ENV_PASSTHROUGH = [
  "DB_HOST",
  "DB_PORT",
  "DB_USERNAME",
  "DB_PASSWORD",
  "DB_ADMIN_USERNAME",
  "DB_ADMIN_PASSWORD",
  "JWT_SECRET",
] as const;

/**
 * Config for the test database. Hermetic: only ENV_PASSTHROUGH comes from process.env.
 * `overrides` are extra env vars (e.g. CORS_ORIGIN) applied last; an `undefined` value removes a
 * variable (including a passthrough one). DB_DATABASE is always the test database.
 */
export function loadTestConfig(overrides: Record<string, string | undefined> = {}): Readonly<Config> {
  const fromEnv: Record<string, string | undefined> = {};
  for (const name of ENV_PASSTHROUGH) fromEnv[name] = process.env[name];
  return loadConfig({
    ...fromEnv,
    NODE_ENV: "test",
    DB_LOGGING: "false",
    TRUST_PROXY: "false",
    // Fixed, published non-secret keys (refused in production), so every run and fixture is reproducible
    CARD_ENCRYPTION_KEY: PUBLISHED_NON_SECRET_KEYS.testEncryption,
    CARD_LOOKUP_KEY: PUBLISHED_NON_SECRET_KEYS.testLookup,
    GIFT_CARD_LINK_BASE_URL: "http://localhost:3000/gift",
    GIFT_CARD_DEV_PRINT_LINKS: "false",
    ...overrides,
    DB_DATABASE: testDb,
  });
}

const testConfig = loadTestConfig();
const admin: DataSource = createDataSource(testConfig, "admin");
const appDataSource: DataSource = createDataSource(testConfig, "app");

/** The app-role data source (running as the least-privileged role). */
export function getAppDataSource(): DataSource {
  return appDataSource;
}

/** Connects both data sources and applies pending migrations as the admin role. */
export async function setupDatabase(): Promise<void> {
  assertTestDatabase(admin.options.database as string | undefined, process.env);
  if (!admin.isInitialized) await admin.initialize();
  await admin.runMigrations();
  if (!appDataSource.isInitialized) await appDataSource.initialize();
}

export async function teardownDatabase(): Promise<void> {
  if (appDataSource.isInitialized) await appDataSource.destroy();
  if (admin.isInitialized) await admin.destroy();
}

/**
 * Builds the Fastify app on the (initialized) app data source, running as the app role.
 * Pass a config (see loadTestConfig) to build it with different settings.
 */
export async function buildTestApp(config: Config = testConfig): Promise<FastifyInstance> {
  if (!appDataSource.isInitialized) await setupDatabase();
  return buildApp({ config, dataSource: appDataSource, logger: false });
}

/** Runs SQL as the admin role (fixtures and direct state changes). */
export async function adminQuery(sql: string, params: unknown[] = []): Promise<unknown> {
  if (!admin.isInitialized) await admin.initialize();
  return admin.query(sql, params);
}

/** Empties every table except the migrations table, using admin creds. */
export async function resetDb(): Promise<void> {
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

/** UUID with version nibble 7 (time-ordered ids) and RFC 4122 variant. */
export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
  tenantId: string;
  adminId: string;
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
  id: string;
  tenantId: string;
  name: string;
  email: string;
  role: string;
}

export interface TenantDto {
  id: string;
  name: string;
  subdomain: string;
}
