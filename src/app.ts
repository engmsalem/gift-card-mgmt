import "reflect-metadata";
import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { DataSource } from "typeorm";
import { config } from "./config";
import { AppDataSource } from "./data-source";
import errorHandler from "./plugins/error-handler";
import jwtPlugin from "./plugins/jwt";
import rateLimit from "./plugins/rate-limit";
import authRoutes from "./routes/authRoutes";
import tenantRoutes from "./routes/tenantRoutes";
import userRoutes from "./routes/userRoutes";

export interface BuildAppOptions {
  // Must already be initialized by the caller
  dataSource?: DataSource;
  logger?: boolean | object;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({
    // Fastify defaults to removeAdditional: true, which silently drops unknown body fields;
    // we want additionalProperties: false to reject them with a 400.
    // Off unless TRUST_PROXY is set: otherwise clients could spoof X-Forwarded-For
    trustProxy: config.trustProxy,
    ajv: { customOptions: { removeAdditional: false } },
    logger: opts.logger ?? {
      level: config.nodeEnv === "production" ? "info" : "debug",
    },
  });

  // Expose the TypeORM DataSource to services as `fastify.db`
  app.decorate("db", opts.dataSource ?? AppDataSource);

  // Register plugins in order
  await app.register(errorHandler); // Register error handler first
  await app.register(rateLimit); // Then rate limiting
  await app.register(cors, {
    origin: config.corsOrigin,
    methods: config.corsMethods,
    allowedHeaders: config.corsAllowedHeaders,
  });
  await app.register(jwtPlugin); // Then authentication

  // Register routes last
  await app.register(authRoutes);
  await app.register(tenantRoutes);
  await app.register(userRoutes);

  return app;
}
