import { DataSource } from "typeorm";
import { User } from "./entities/user";
import "dotenv/config";

export const AppDataSource = new DataSource({
  type: "mariadb",
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "5432"),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  synchronize: process.env.NODE_ENV !== "production",
  logging: process.env.NODE_ENV !== "production",
  entities: [User],
  migrations: [],
  subscribers: [],
});

if (!process.env.DB_USERNAME || !process.env.DB_PASSWORD) {
  throw new Error("Database configuration missing");
}
