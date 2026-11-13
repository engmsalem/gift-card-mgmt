// Entry point for the TypeORM CLI (it needs a module whose default export is a DataSource).
// Loads .env, connects as the schema-owning admin role. Nothing else may import this module.
import "dotenv/config";
import { loadDbConfig } from "./config";
import { createDataSource } from "./data-source";

export default createDataSource(loadDbConfig(process.env), "admin");
