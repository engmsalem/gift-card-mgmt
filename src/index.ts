import "reflect-metadata";
import Fastify, { FastifyInstance } from "fastify";
import { AppDataSource } from "./data-source";
import errorHandler from "./plugins/error-handler";
import jwtPlugin from "./plugins/jwt";
import rateLimit from "./plugins/rate-limit";

AppDataSource.initialize()
  .then(() => {
    console.log("Database connected");

    const app: FastifyInstance = Fastify({
      logger: {
        level: process.env.NODE_ENV === "production" ? "info" : "debug",
      },
    });

    // Register plugins in order
    app.register(errorHandler); // Register error handler first
    app.register(rateLimit); // Then rate limiting
    app.register(jwtPlugin); // Then authentication

    // Register routes last
    app.register(import("./routes/auth"));
    app.register(import("./routes/user"));

    const start = async () => {
      try {
        await app.listen({ port: 3000 });
      } catch (err) {
        app.log.error(err);
        process.exit(1);
      }
    };
    start();
  })
  .catch((error) => console.log(error));
