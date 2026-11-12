import { DataSource } from "typeorm";
import { config } from "./config";
import { baseOptions } from "./data-source";

// Used by the TypeORM CLI and the test helpers: connects as the schema-owning admin role.
export default new DataSource({
  ...baseOptions,
  username: config.dbAdminUsername,
  password: config.dbAdminPassword,
});
