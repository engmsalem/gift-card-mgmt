import "reflect-metadata";
import { DataSource } from "typeorm";
import type { Config } from "./config";
import { RefreshToken } from "./entities/refresh-token";
import { Tenant } from "./entities/tenant";
import { User } from "./entities/user";

/**
 * Builds (does not initialize) a DataSource from an explicit config. The "app" role is the
 * least-privileged one (no DDL); "admin" is the schema-owning role used by migrations.
 * The schema is owned by src/migrations; synchronize is never enabled.
 */
export function createDataSource(config: Config, role: "app" | "admin"): DataSource {
  return new DataSource({
    type: "postgres",
    host: config.dbHost,
    port: config.dbPort,
    database: config.dbDatabase,
    username: role === "admin" ? config.dbAdminUsername : config.dbUsername,
    password: role === "admin" ? config.dbAdminPassword : config.dbPassword,
    synchronize: false,
    logging: config.dbLogging,
    entities: [Tenant, User, RefreshToken],
    // Resolves to .ts under ts-node (src/) and .js when compiled (dist/)
    migrations: [__dirname + "/migrations/*.{ts,js}"],
  });
}
