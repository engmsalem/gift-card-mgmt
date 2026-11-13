import "reflect-metadata";
import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { DataSource } from "typeorm";
import type { Config } from "./config";
import { selectDeliverySender } from "./delivery/select-sender";
import { CardCrypto } from "./gift-cards/card-crypto";
import errorHandler from "./plugins/error-handler";
import jwtPlugin from "./plugins/jwt";
import rateLimit from "./plugins/rate-limit";
import authRoutes from "./routes/authRoutes";
import giftCardLinkRoutes from "./routes/giftCardLinkRoutes";
import giftCardProgramRoutes from "./routes/giftCardProgramRoutes";
import giftCardRoutes from "./routes/giftCardRoutes";
import tenantRoutes from "./routes/tenantRoutes";
import userRoutes from "./routes/userRoutes";
import { verifyCardKeys } from "./services/cardKeyCheck";
import { DeliveryDispatcher, GiftCardDeliverySender } from "./services/deliveryDispatcher";

// A request that cannot get a card row lock within this long answers 503 instead of queueing
const DEFAULT_LOCK_TIMEOUT_MS = 5000;

// Backstop for design 7.9: the error handler already reduces database errors to code, constraint and
// table; these paths remove the fields that carry row data and request values if one is logged whole.
const REDACT_PATHS = ["err.detail", "err.where", "err.parameters", "err.query", "err.driverError"];

// Merges the redaction into the logger options, including caller-supplied ones (tests pass a stream)
function withRedaction(logger: boolean | object): boolean | object {
  if (logger === false) return false;
  const base: { redact?: unknown } = logger === true ? {} : logger;
  const existing = Array.isArray(base.redact)
    ? (base.redact as string[])
    : ((base.redact as { paths?: string[] } | undefined)?.paths ?? []);
  return { ...base, redact: { paths: [...existing, ...REDACT_PATHS], censor: "[REDACTED]" } };
}

export interface BuildAppOptions {
  config: Config;
  // Must already be initialized by the caller
  dataSource: DataSource;
  logger?: boolean | object;
  giftCards?: {
    // Replaces the configured sender (tests inject a recording one); never set in production
    deliverySender?: GiftCardDeliverySender;
    // Bounds redemption and refund waits on a card row; tests shorten or lengthen it
    lockTimeoutMs?: number;
    sendTimeoutMs?: number;
  };
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
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
    trustProxy: opts.config.trustProxy,
    logger: withRedaction(
      opts.logger ?? {
        level: opts.config.nodeEnv === "production" ? "info" : "debug",
      }
    ),
  });

  // Once Fastify exists, a failed registration must not leave it (and its hooks) open
  try {
    // Expose the TypeORM DataSource to services as `fastify.db`
    app.decorate("db", opts.dataSource);

    // Composition root for the card crypto. Startup refuses a card key that does not match the check
    // value recorded for its id (this needs gift_card_key_checks: run the migrations first), before
    // any route exists. The catch below closes the instance and rethrows.
    const cardCrypto = new CardCrypto({
      encryption: opts.config.cardEncryptionKey,
      lookup: opts.config.cardLookupKey,
    });
    await verifyCardKeys(opts.dataSource, cardCrypto);

    // Many clients send `Content-Type: application/json` with no body. Fastify answers that with a
    // 400 before the route runs, which would break the routes whose body is optional (resend,
    // suspend, ...). An empty body is parsed as no body; routes whose schema requires one still
    // answer 400 (validation), and anything else goes to Fastify's own parser with its defaults.
    const parseJson = app.getDefaultJsonParser("error", "error"); // the Fastify defaults, stated
    app.removeContentTypeParser("application/json");
    app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
      if (body === "") return done(null, undefined);
      // The callback form (its type also allows a promise, which this parser never returns)
      void parseJson(request, body as string, done);
    });

    // Register plugins in order
    await app.register(errorHandler); // Register error handler first
    // CORS before rate limiting: its onRequest hook then sets CORS headers on every response
    // (including 429s) and answers preflight OPTIONS requests before they are counted
    await app.register(cors, {
      origin: opts.config.corsOrigin,
      methods: opts.config.corsMethods,
      allowedHeaders: opts.config.corsAllowedHeaders,
    });
    await app.register(rateLimit);
    await app.register(jwtPlugin, { secret: opts.config.jwtSecret }); // Then authentication

    // Register routes last
    await app.register(authRoutes);
    await app.register(tenantRoutes);
    await app.register(userRoutes);
    await app.register(giftCardProgramRoutes);

    // Composition root for delivery. Throws a ConfigError in production when there is no provider
    // (see selectDeliverySender); the catch below closes the instance and rethrows.
    const sender = selectDeliverySender({
      override: opts.giftCards?.deliverySender,
      nodeEnv: opts.config.nodeEnv,
      devPrintLinks: opts.config.giftCardDevPrintLinks,
      log: app.log,
    });
    const dispatcher = new DeliveryDispatcher({
      db: opts.dataSource,
      sender,
      linkBaseUrl: opts.config.giftCardLinkBaseUrl,
      log: app.log,
      sendTimeoutMs: opts.giftCards?.sendTimeoutMs,
    });
    await app.register(giftCardRoutes, {
      cardCrypto,
      dispatcher,
      lockTimeoutMs: opts.giftCards?.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    });
    await app.register(giftCardLinkRoutes, { cardCrypto, dispatcher });

    return app;
  } catch (err) {
    await app.close().catch(() => undefined);
    throw err;
  }
}
