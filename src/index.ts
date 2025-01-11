import "reflect-metadata";
import Fastify, { FastifyInstance } from "fastify";
import { AppDataSource } from "./data-source";
import errorHandler from "./plugins/error-handler";
import jwtPlugin from "./plugins/jwt";
import rateLimit from "./plugins/rate-limit";
import cors from "@fastify/cors";
import dotenv from "dotenv"; // Import dotenv

dotenv.config(); // Load environment variables
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
    app.register(cors, {
      origin: process.env.CORS_ORIGIN || "*", // Use environment variable or default to "*"
      methods: process.env.CORS_METHODS?.split(",") || [
        "GET",
        "POST",
        "PUT",
        "DELETE",
      ], // Split methods from env
      allowedHeaders: process.env.CORS_ALLOWED_HEADERS?.split(",") || [
        "Content-Type",
        "Authorization",
      ], // Split headers from env
    });
    app.register(jwtPlugin); // Then authentication

    // Register routes last
    app.register(import("./routes/authRoutes"));
    app.register(import("./routes/userRoutes"));

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
