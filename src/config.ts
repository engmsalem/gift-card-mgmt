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

// Everything the API process needs. Migrations and scripts need only DbConfig.
export type Config = DbConfig & ServerConfig;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

export const MIN_JWT_SECRET_LENGTH = 32;

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

function readServerConfig(env: Env, read: Reader): ServerConfig {
  const nodeEnv = read.str("NODE_ENV", "development");

  // No silent wildcard in production: the operator has to choose the allowed origins
  if (nodeEnv === "production" && (env.CORS_ORIGIN === undefined || env.CORS_ORIGIN === "")) {
    read.problem('CORS_ORIGIN is required when NODE_ENV is "production" (use "*" to allow any origin)');
  }
  const corsOrigins = read.list("CORS_ORIGIN", ["*"]);
  if (corsOrigins.length === 0) read.problem("CORS_ORIGIN must contain at least one origin");
  if (corsOrigins.length > 1 && corsOrigins.includes("*")) {
    read.problem('CORS_ORIGIN "*" must be used alone, not mixed with other origins');
  }

  const corsMethods = read.list("CORS_METHODS", ["GET", "POST", "PUT", "DELETE"]);
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
  const config = readServerConfig(env, createReader(env, problems));
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
  const config: Config = { ...readDbConfig(env, read), ...readServerConfig(env, read) };
  throwIfProblems(problems);
  return Object.freeze(config);
}
