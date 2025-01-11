import { DataSource } from "typeorm";
import { User } from "../entities/user";
import { Role } from "../enums/roles";
import { UserRepository } from "../repositories/userRepository"; // Import the repository

export const AppDataSource = new DataSource({
  type: "postgres", // or another database type
  host: "localhost",
  port: 5432,
  username: "test",
  password: "test",
  database: "test",
  synchronize: true,
  logging: false,
  entities: [User],
  migrations: [],
  subscribers: [],
});

// Initialize the connection
AppDataSource.initialize()
  .then(() => {
    console.log("Data Source has been initialized!");
  })
  .catch((error) => {
    console.error("Error during Data Source initialization:", error);
  });
