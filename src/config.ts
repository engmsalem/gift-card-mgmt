import { createHash } from "node:crypto";
import type { CardKey } from "./gift-cards/card-crypto";

export interface DbConfig {
  dbHost: string;
  dbPort: number;
  dbDatabase: string;
  // Least-privileged role used by the running app
  dbUsername: string;
  dbPassword: string;
  // Schema-owning role used only by migrations. Set both DB_ADMIN_* variables or neither;
  // with neither, the app credentials are used for both (single-user mode, no DML-only role).
  dbAdminUsername: string;
  dbAdminPassword: string;
  dbLogging: boolean;
}

export interface ServerConfig {
  nodeEnv: string;
  // Interface the HTTP server binds to
  host: string;
  port: number;
  jwtSecret: string;
  // Set only behind a trusted reverse proxy: makes request.ip (and rate limiting) use X-Forwarded-For
  trustProxy: boolean;
  // A single origin (or "*") stays a string; several become a list
  corsOrigin: string | string[];
  corsMethods: string[];
  corsAllowedHeaders: string[];
}

export interface GiftCardConfig {
  // Hex-decoded keys (32 bytes) with their key ids
  cardEncryptionKey: CardKey;
  cardLookupKey: CardKey;
  // Where delivery links point; the token is appended as a "#token=" fragment
  giftCardLinkBaseUrl: string;
  // Development only: print delivery links to the console instead of just logging
  giftCardDevPrintLinks: boolean;
}

// Everything the API process needs. Migrations and scripts need only DbConfig.
export type Config = DbConfig & ServerConfig & GiftCardConfig;

// What the delivery dispatch script needs: it never decrypts, so it has no card keys.
export type DispatchConfig = DbConfig &
  Pick<GiftCardConfig, "giftCardDevPrintLinks"> & { giftCardLinkBaseUrl: string; nodeEnv: string };

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

export const MIN_JWT_SECRET_LENGTH = 32;

const CARD_KEY_BYTES = 32;
const MIN_DISTINCT_KEY_BYTES = 16;
const MAX_CARD_KEY_ID = 32767;
const DEFAULT_GIFT_CARD_LINK_BASE_URL = "http://localhost:3000/gift";
// Exact, lowercase. Production safeguards key off "production", so a typo must not fall through.
const NODE_ENVS = ["development", "test", "production"] as const;

const derivedKey = (label: string): string => createHash("sha256").update(label).digest("hex");

// Keys that are committed to the repository (tests, CI). They protect nothing, so production
// refuses them.
export const PUBLISHED_NON_SECRET_KEYS = {
  testEncryption: derivedKey("gift-card-test-encryption-key"),
  testLookup: derivedKey("gift-card-test-lookup-key"),
  ciEncryption: derivedKey("gift-card-ci-encryption-key"),
  ciLookup: derivedKey("gift-card-ci-lookup-key"),
} as const;

const PUBLISHED_KEY_SET: ReadonlySet<string> = new Set(Object.values(PUBLISHED_NON_SECRET_KEYS));

/** Typed readers over one env that record every problem into a shared list. */
function createReader(env: Env, problems: string[]) {
  const str = (name: string, fallback?: string): string => {
    const value = env[name];
    if (value !== undefined && value !== "") return value;
    if (fallback !== undefined) return fallback;
    problems.push(`${name} is required`);
    return "";
  };

  const int = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 65535) {
      problems.push(`${name} must be an integer between 0 and 65535 (got "${raw}")`);
      return fallback;
    }
    return value;
  };

  const bool = (name: string, fallback: boolean): boolean => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const normalized = raw.toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
    problems.push(`${name} must be "true" or "false" (got "${raw}")`);
    return fallback;
  };

  const list = (name: string, fallback: string[]): string[] => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    return raw.split(",").map((item) => item.trim()).filter(Boolean);
  };

  // Records a problem that is not tied to a single variable's parsing
  const problem = (message: string): void => {
    problems.push(message);
  };

  return { str, int, bool, list, problem };
}

type Reader = ReturnType<typeof createReader>;

/**
 * NODE_ENV for every entry point. Unset or empty is "development"; any value outside NODE_ENVS
 * is a problem (and reads as "development" so it does not add misleading follow-on problems).
 */
function readNodeEnv(env: Env, read: Reader): string {
  const raw = read.str("NODE_ENV", "development");
  if ((NODE_ENVS as readonly string[]).includes(raw)) return raw;
  read.problem(`NODE_ENV must be one of ${NODE_ENVS.join(", ")} (got "${raw}")`);
  return "development";
}

function readDbConfig(env: Env, read: Reader): DbConfig {
  const dbUsername = read.str("DB_USERNAME");
  const dbPassword = read.str("DB_PASSWORD");

  // Admin credentials are a pair: both set, or both unset (then the app credentials are used)
  const adminUserSet = (env.DB_ADMIN_USERNAME ?? "") !== "";
  const adminPasswordSet = (env.DB_ADMIN_PASSWORD ?? "") !== "";
  const hasAdminPair = adminUserSet && adminPasswordSet;
  if (adminUserSet !== adminPasswordSet) {
    read.problem(
      adminUserSet
        ? "DB_ADMIN_PASSWORD is required when DB_ADMIN_USERNAME is set"
        : "DB_ADMIN_USERNAME is required when DB_ADMIN_PASSWORD is set"
    );
  }

  return {
    dbHost: read.str("DB_HOST", "localhost"),
    dbPort: read.int("DB_PORT", 5432),
    dbDatabase: read.str("DB_DATABASE"),
    dbUsername,
    dbPassword,
    dbAdminUsername: hasAdminPair ? read.str("DB_ADMIN_USERNAME") : dbUsername,
    dbAdminPassword: hasAdminPair ? read.str("DB_ADMIN_PASSWORD") : dbPassword,
    dbLogging: read.bool("DB_LOGGING", false),
  };
}

function readServerConfig(env: Env, read: Reader, nodeEnv: string): ServerConfig {
  // No silent wildcard in production: the operator has to choose the allowed origins
  if (nodeEnv === "production" && (env.CORS_ORIGIN === undefined || env.CORS_ORIGIN === "")) {
    read.problem('CORS_ORIGIN is required when NODE_ENV is "production" (use "*" to allow any origin)');
  }
  const corsOrigins = read.list("CORS_ORIGIN", ["*"]);
  if (corsOrigins.length === 0) read.problem("CORS_ORIGIN must contain at least one origin");
  if (corsOrigins.length > 1 && corsOrigins.includes("*")) {
    read.problem('CORS_ORIGIN "*" must be used alone, not mixed with other origins');
  }

  const corsMethods = read.list("CORS_METHODS", ["GET", "POST", "PUT", "PATCH", "DELETE"]);
  if (corsMethods.length === 0) read.problem("CORS_METHODS must contain at least one method");
  const corsAllowedHeaders = read.list("CORS_ALLOWED_HEADERS", ["Content-Type", "Authorization"]);
  if (corsAllowedHeaders.length === 0) {
    read.problem("CORS_ALLOWED_HEADERS must contain at least one header");
  }

  let jwtSecret = env.JWT_SECRET ?? "";
  if (jwtSecret === "") {
    read.problem("JWT_SECRET is required");
  } else if (jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    read.problem(
      `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters (got ${jwtSecret.length})`
    );
    jwtSecret = "";
  }

  return {
    nodeEnv,
    host: read.str("HOST", "localhost"),
    port: read.int("PORT", 3000),
    jwtSecret,
    trustProxy: read.bool("TRUST_PROXY", false),
    corsOrigin: corsOrigins.length === 1 ? corsOrigins[0] : corsOrigins,
    corsMethods,
    corsAllowedHeaders,
  };
}

/**
 * Reads one card key (hex, 32 bytes, at least 16 distinct byte values) and its id. Messages name
 * the variables and never echo a value. Returns the hex too, for the cross-key checks.
 */
function readCardKey(
  env: Env,
  read: Reader,
  keyVar: string,
  idVar: string,
  production: boolean
): { key: CardKey; hex: string } {
  const raw = env[keyVar] ?? "";
  let key = Buffer.alloc(0);
  let hex = "";
  if (raw === "") {
    read.problem(`${keyVar} is required`);
  } else if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    read.problem(`${keyVar} must be ${CARD_KEY_BYTES * 2} hexadecimal characters (${CARD_KEY_BYTES} bytes)`);
  } else {
    const candidate = Buffer.from(raw, "hex");
    if (new Set(candidate).size < MIN_DISTINCT_KEY_BYTES) {
      read.problem(`${keyVar} is too low-entropy (needs at least ${MIN_DISTINCT_KEY_BYTES} distinct byte values)`);
    } else if (production && PUBLISHED_KEY_SET.has(raw.toLowerCase())) {
      read.problem(`${keyVar} is a published test/CI key and cannot be used when NODE_ENV is "production"`);
    } else {
      key = candidate;
      hex = raw.toLowerCase();
    }
  }

  let id = 1;
  const rawId = env[idVar];
  if (rawId !== undefined && rawId !== "") {
    const parsed = Number(rawId);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CARD_KEY_ID) {
      read.problem(`${idVar} must be an integer between 1 and ${MAX_CARD_KEY_ID}`);
    } else {
      id = parsed;
    }
  }
  return { key: { id, key }, hex };
}

/** Delivery link settings, shared by the API (readGiftCardConfig) and the dispatch script. */
function readLinkConfig(
  env: Env,
  read: Reader,
  nodeEnv: string
): Pick<GiftCardConfig, "giftCardLinkBaseUrl" | "giftCardDevPrintLinks"> {
  const production = nodeEnv === "production";
  const raw = production ? read.str("GIFT_CARD_LINK_BASE_URL") : read.str("GIFT_CARD_LINK_BASE_URL", DEFAULT_GIFT_CARD_LINK_BASE_URL);
  if (raw !== "") {
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        read.problem("GIFT_CARD_LINK_BASE_URL must be an http(s) URL");
      } else if (production && url.protocol !== "https:") {
        read.problem('GIFT_CARD_LINK_BASE_URL must use https when NODE_ENV is "production"');
      }
      if (raw.includes("#")) read.problem("GIFT_CARD_LINK_BASE_URL must not contain a fragment");
    } catch {
      read.problem("GIFT_CARD_LINK_BASE_URL must be a valid URL");
    }
  }

  const devPrintLinks = read.bool("GIFT_CARD_DEV_PRINT_LINKS", false);
  if (devPrintLinks && nodeEnv !== "development") {
    read.problem('GIFT_CARD_DEV_PRINT_LINKS=true is allowed only when NODE_ENV is "development"');
  }
  return { giftCardLinkBaseUrl: raw, giftCardDevPrintLinks: devPrintLinks };
}

/** Gift card keys and delivery link settings. Not part of readServerConfig (see loadConfig). */
function readGiftCardConfig(env: Env, read: Reader, nodeEnv: string): GiftCardConfig {
  const production = nodeEnv === "production";
  const encryption = readCardKey(env, read, "CARD_ENCRYPTION_KEY", "CARD_ENCRYPTION_KEY_ID", production);
  const lookup = readCardKey(env, read, "CARD_LOOKUP_KEY", "CARD_LOOKUP_KEY_ID", production);
  if (encryption.hex !== "" && encryption.hex === lookup.hex) {
    read.problem("CARD_LOOKUP_KEY must differ from CARD_ENCRYPTION_KEY");
  }
  return {
    cardEncryptionKey: encryption.key,
    cardLookupKey: lookup.key,
    ...readLinkConfig(env, read, nodeEnv),
  };
}

// DB_LOGGING prints every statement with its parameters, which carry personal data
function checkDbLogging(read: Reader, dbLogging: boolean, nodeEnv: string): void {
  if (dbLogging && nodeEnv === "production") {
    read.problem('DB_LOGGING=true is not allowed when NODE_ENV is "production" (it logs SQL parameters)');
  }
}

function throwIfProblems(problems: string[]): void {
  if (problems.length > 0) {
    throw new ConfigError(
      `Invalid configuration (see .env.example):\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
  }
}

/**
 * Database settings only (migrations, scripts): needs no API secrets such as JWT_SECRET or
 * CORS_ORIGIN. Collects every problem and throws once, naming each offending variable.
 */
export function loadDbConfig(env: Env): Readonly<DbConfig> {
  const problems: string[] = [];
  const config = readDbConfig(env, createReader(env, problems));
  throwIfProblems(problems);
  return Object.freeze(config);
}

/** HTTP server settings only. Collects every problem and throws once. */
export function loadServerConfig(env: Env): Readonly<ServerConfig> {
  const problems: string[] = [];
  const read = createReader(env, problems);
  const config = readServerConfig(env, read, readNodeEnv(env, read));
  throwIfProblems(problems);
  return Object.freeze(config);
}

/**
 * Full configuration for the API process: database and server settings, validated together
 * so one ConfigError lists every problem.
 */
export function loadConfig(env: Env): Readonly<Config> {
  const problems: string[] = [];
  const read = createReader(env, problems);
  const nodeEnv = readNodeEnv(env, read);
  const config: Config = {
    ...readDbConfig(env, read),
    ...readServerConfig(env, read, nodeEnv),
    ...readGiftCardConfig(env, read, nodeEnv),
  };
  checkDbLogging(read, config.dbLogging, config.nodeEnv);
  throwIfProblems(problems);
  return Object.freeze(config);
}

/**
 * Settings for the delivery dispatch script: database and delivery link settings, with no card
 * keys (it never decrypts) and no API secrets.
 */
export function loadDispatchConfig(env: Env): Readonly<DispatchConfig> {
  const problems: string[] = [];
  const read = createReader(env, problems);
  const nodeEnv = readNodeEnv(env, read);
  const config: DispatchConfig = { ...readDbConfig(env, read), ...readLinkConfig(env, read, nodeEnv), nodeEnv };
  checkDbLogging(read, config.dbLogging, nodeEnv);
  throwIfProblems(problems);
  return Object.freeze(config);
}
