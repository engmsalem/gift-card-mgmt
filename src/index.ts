import "reflect-metadata";
import { createConnection } from "typeorm";
import fastify from "fastify";
import jwt from "@fastify/jwt";
import { AppDataSource } from "./data-source";

// Initialize TypeORM before setting up Fastify
AppDataSource.initialize()
  .then(() => {
    console.log("Database connected");

    const app = fastify();
    app.register(jwt, {
      secret: "your-secret-key",
    });

    app.get("/", async (request, reply) => {
      return { hello: "world" };
    });

    app.listen({ port: 3000 }, (err, address) => {
      if (err) {
        console.error(err);
        process.exit(1);
      }
      console.log(`Server listening at ${address}`);
    });
  })
  .catch((error) => console.log(error));
