import "reflect-metadata";
import { DataSource } from "typeorm";
import type { DbConfig } from "./config";
import { RefreshToken } from "./entities/refresh-token";
import { Tenant } from "./entities/tenant";
import { User } from "./entities/user";

/**
 * Builds (does not initialize) a DataSource from an explicit config. The "app" role is the
 * least-privileged one (no DDL); "admin" is the schema-owning role used by migrations.
 * The schema is owned by src/migrations; synchronize is never enabled.
 */
export function createDataSource(config: DbConfig, role: "app" | "admin"): DataSource {
  const credentials =
    role === "admin"
      ? { username: config.dbAdminUsername, password: config.dbAdminPassword }
      : { username: config.dbUsername, password: config.dbPassword };
  return new DataSource({
    type: "postgres",
    host: config.dbHost,
    port: config.dbPort,
    database: config.dbDatabase,
    ...credentials,
    synchronize: false,
    logging: config.dbLogging,
    entities: [Tenant, User, RefreshToken],
    // Resolves to .ts under ts-node (src/) and .js when compiled (dist/)
    migrations: [__dirname + "/migrations/*.{ts,js}"],
  });
}
