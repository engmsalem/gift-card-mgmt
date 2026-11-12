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
    // Fastify also defaults to coerceTypes: "array" (a number becomes a string, a one-element
    // array becomes its element), which would let `password: 12345678` or `email: ["a@b.com"]`
    // through to the services; we want a wrong type to be a 400. There are no querystring or
    // params schemas today; a future one must declare explicit types (e.g. integer) and parse
    // them itself, since nothing is coerced to them any more.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    // Off unless TRUST_PROXY is set: otherwise clients could spoof X-Forwarded-For
    trustProxy: config.trustProxy,
    logger: opts.logger ?? {
      level: config.nodeEnv === "production" ? "info" : "debug",
    },
  });

  // Expose the TypeORM DataSource to services as `fastify.db`
  app.decorate("db", opts.dataSource ?? AppDataSource);

  // Register plugins in order
  await app.register(errorHandler); // Register error handler first
  // CORS before rate limiting: its onRequest hook then sets CORS headers on every response
  // (including 429s) and answers preflight OPTIONS requests before they are counted
  await app.register(cors, {
    origin: config.corsOrigin,
    methods: config.corsMethods,
    allowedHeaders: config.corsAllowedHeaders,
  });
  await app.register(rateLimit);
  await app.register(jwtPlugin); // Then authentication

  // Register routes last
  await app.register(authRoutes);
  await app.register(tenantRoutes);
  await app.register(userRoutes);

  return app;
}
