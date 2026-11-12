import "reflect-metadata";
import { DataSource, DataSourceOptions } from "typeorm";
import { config } from "./config";
import { RefreshToken } from "./entities/refresh-token";
import { Tenant } from "./entities/tenant";
import { User } from "./entities/user";

// Shared by the app and migration data sources. Credentials are added by each caller.
// The schema is owned by src/migrations; synchronize is never enabled.
export const baseOptions = {
  type: "postgres",
  host: config.dbHost,
  port: config.dbPort,
  database: config.dbDatabase,
  synchronize: false,
  logging: config.dbLogging,
  entities: [Tenant, User, RefreshToken],
  // Resolves to .ts under ts-node (src/) and .js when compiled (dist/)
  migrations: [__dirname + "/migrations/*.{ts,js}"],
} as const satisfies DataSourceOptions;

// Runs as the least-privileged app role (no DDL).
export const AppDataSource = new DataSource({
  ...baseOptions,
  username: config.dbUsername,
  password: config.dbPassword,
});
