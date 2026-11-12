import fp from "fastify-plugin";
import jwt from "@fastify/jwt";
import { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config";
import { ForbiddenError, UnauthorizedError } from "../errors";
import { Role } from "../enums/roles";
import { ACCESS_TOKEN_TTL_SECONDS } from "../tokens";

export const ACCESS_TOKEN_TYPE = "access";

export default fp(async function (fastify: FastifyInstance) {
  await fastify.register(jwt, {
    secret: config.jwtSecret,
    sign: { algorithm: "HS256", expiresIn: ACCESS_TOKEN_TTL_SECONDS },
    verify: { algorithms: ["HS256"] },
    // request.user is the minimal identity the app needs, not the raw claims
    formatUser: (payload) => ({
      id: payload.sub,
      tenantId: payload.tid,
      role: payload.role,
    }),
  });

  fastify.decorate("authenticate", async function (request: FastifyRequest) {
    try {
      await request.jwtVerify();
    } catch {
      throw new UnauthorizedError("Invalid or missing token");
    }
    // formatUser drops claims, so read `typ` from the (already verified) token
    const { typ } = await request.jwtDecode<{ typ?: string }>();
    if (typ !== ACCESS_TOKEN_TYPE) {
      throw new UnauthorizedError("Invalid or missing token");
    }
  });
});

/** preHandler factory; use after `fastify.authenticate`. */
export function requireRole(...roles: Role[]) {
  return async function (request: FastifyRequest): Promise<void> {
    if (!roles.includes(request.user.role)) {
      throw new ForbiddenError("Insufficient permissions");
    }
  };
}
