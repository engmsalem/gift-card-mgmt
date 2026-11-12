import "dotenv/config";

export interface Config {
  port: number;
  nodeEnv: string;
  dbHost: string;
  dbPort: number;
  dbDatabase: string;
  // Least-privileged role used by the running app
  dbUsername: string;
  dbPassword: string;
  // Schema-owning role used only by migrations (defaults to the app credentials)
  dbAdminUsername: string;
  dbAdminPassword: string;
  dbLogging: boolean;
  jwtSecret: string;
  corsOrigin: string;
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

  const dbUsername = str("DB_USERNAME");
  const dbPassword = str("DB_PASSWORD");

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
    port: int("PORT", 3000),
    nodeEnv: str("NODE_ENV", "development"),
    dbHost: str("DB_HOST", "localhost"),
    dbPort: int("DB_PORT", 5432),
    dbDatabase: str("DB_DATABASE"),
    dbUsername,
    dbPassword,
    dbAdminUsername: str("DB_ADMIN_USERNAME", dbUsername),
    dbAdminPassword: str("DB_ADMIN_PASSWORD", dbPassword),
    dbLogging: bool("DB_LOGGING", false),
    jwtSecret,
    corsOrigin: str("CORS_ORIGIN", "*"),
    corsMethods: list("CORS_METHODS", ["GET", "POST", "PUT", "DELETE"]),
    corsAllowedHeaders: list("CORS_ALLOWED_HEADERS", ["Content-Type", "Authorization"]),
  };

  if (problems.length > 0) {
    throw new ConfigError(
      `Invalid configuration (see .env.example):\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
  }

  return Object.freeze(config);
}

export const config: Readonly<Config> = loadConfig(process.env);
