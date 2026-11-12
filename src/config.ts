export interface Config {
  // Interface the HTTP server binds to
  host: string;
  port: number;
  nodeEnv: string;
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
  jwtSecret: string;
  // Set only behind a trusted reverse proxy: makes request.ip (and rate limiting) use X-Forwarded-For
  trustProxy: boolean;
  // A single origin (or "*") stays a string; several become a list
  corsOrigin: string | string[];
  corsMethods: string[];
  corsAllowedHeaders: string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

const MIN_JWT_SECRET_LENGTH = 32;

/**
 * Reads and validates environment variables. Collects every problem and throws once,
 * naming each offending variable.
 */
export function loadConfig(env: Env): Readonly<Config> {
  const problems: string[] = [];

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

  const nodeEnv = str("NODE_ENV", "development");

  // No silent wildcard in production: the operator has to choose the allowed origins
  if (nodeEnv === "production" && (env.CORS_ORIGIN === undefined || env.CORS_ORIGIN === "")) {
    problems.push('CORS_ORIGIN is required when NODE_ENV is "production" (use "*" to allow any origin)');
  }
  const corsOrigins = list("CORS_ORIGIN", ["*"]);
  if (corsOrigins.length === 0) problems.push("CORS_ORIGIN must contain at least one origin");
  if (corsOrigins.length > 1 && corsOrigins.includes("*")) {
    problems.push('CORS_ORIGIN "*" must be used alone, not mixed with other origins');
  }

  const corsMethods = list("CORS_METHODS", ["GET", "POST", "PUT", "DELETE"]);
  if (corsMethods.length === 0) problems.push("CORS_METHODS must contain at least one method");
  const corsAllowedHeaders = list("CORS_ALLOWED_HEADERS", ["Content-Type", "Authorization"]);
  if (corsAllowedHeaders.length === 0) {
    problems.push("CORS_ALLOWED_HEADERS must contain at least one header");
  }

  const dbUsername = str("DB_USERNAME");
  const dbPassword = str("DB_PASSWORD");

  // Admin credentials are a pair: both set, or both unset (then the app credentials are used)
  const adminUserSet = (env.DB_ADMIN_USERNAME ?? "") !== "";
  const adminPasswordSet = (env.DB_ADMIN_PASSWORD ?? "") !== "";
  if (adminUserSet !== adminPasswordSet) {
    problems.push(
      adminUserSet
        ? "DB_ADMIN_PASSWORD is required when DB_ADMIN_USERNAME is set"
        : "DB_ADMIN_USERNAME is required when DB_ADMIN_PASSWORD is set"
    );
  }

  let jwtSecret = env.JWT_SECRET ?? "";
  if (jwtSecret === "") {
    problems.push("JWT_SECRET is required");
  } else if (jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    problems.push(
      `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters (got ${jwtSecret.length})`
    );
    jwtSecret = "";
  }

  const config: Config = {
    host: str("HOST", "localhost"),
    port: int("PORT", 3000),
    nodeEnv,
    dbHost: str("DB_HOST", "localhost"),
    dbPort: int("DB_PORT", 5432),
    dbDatabase: str("DB_DATABASE"),
    dbUsername,
    dbPassword,
    dbAdminUsername: adminUserSet && adminPasswordSet ? str("DB_ADMIN_USERNAME") : dbUsername,
    dbAdminPassword: adminUserSet && adminPasswordSet ? str("DB_ADMIN_PASSWORD") : dbPassword,
    dbLogging: bool("DB_LOGGING", false),
    jwtSecret,
    trustProxy: bool("TRUST_PROXY", false),
    corsOrigin: corsOrigins.length === 1 ? corsOrigins[0] : corsOrigins,
    corsMethods,
    corsAllowedHeaders,
  };

  if (problems.length > 0) {
    throw new ConfigError(
      `Invalid configuration (see .env.example):\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
  }

  return Object.freeze(config);
}
