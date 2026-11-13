import fp from "fastify-plugin";
import jwt from "@fastify/jwt";
import { FastifyInstance, FastifyRequest } from "fastify";
import { MIN_JWT_SECRET_LENGTH } from "../config";
import { ForbiddenError, UnauthorizedError } from "../errors";
import { Role } from "../enums/roles";
import { ACCESS_TOKEN_TTL_SECONDS } from "../tokens";

export const ACCESS_TOKEN_TYPE = "access";

export interface JwtPluginOptions {
  secret: string;
}

export default fp<JwtPluginOptions>(async function (fastify: FastifyInstance, opts) {
  // loadConfig already enforces this; checked again so a hand-built config cannot sign with a weak key
  if (typeof opts.secret !== "string" || opts.secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(`JWT secret must be at least ${MIN_JWT_SECRET_LENGTH} characters`);
  }

  await fastify.register(jwt, {
    secret: opts.secret,
    sign: { algorithm: "HS256", expiresIn: ACCESS_TOKEN_TTL_SECONDS },
    verify: { algorithms: ["HS256"] },
    // request.user is the minimal identity the app needs, not the raw claims
    formatUser: (payload) => ({
      id: payload.sub,
      tenantId: payload.tid,
      role: payload.role,
      typ: payload.typ,
    }),
  });

  fastify.decorate("authenticate", async function (request: FastifyRequest) {
    try {
      await request.jwtVerify();
    } catch {
      throw new UnauthorizedError("Invalid or missing token");
    }
    // A validly signed refresh (or typ-less) JWT must not work as an access token
    if (request.user.typ !== ACCESS_TOKEN_TYPE) {
      throw new UnauthorizedError("Invalid or missing token");
    }
  });
});

/** onRequest hook factory (runs before body parsing and validation); use after `fastify.authenticate`. */
export function requireRole(...roles: Role[]) {
  return async function (request: FastifyRequest): Promise<void> {
    if (!roles.includes(request.user.role)) {
      throw new ForbiddenError("Insufficient permissions");
    }
  };
}
