import fp from "fastify-plugin";
import { FastifyInstance, FastifyRequest, FastifyReply, FastifyError } from "fastify";
import { AppError } from "../errors";

const PG_UNIQUE_VIOLATION = "23505";

// TypeORM's QueryFailedError copies the driver error's fields onto itself and also keeps
// the original under `driverError`.
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; driverError?: { code?: unknown } };
  return e.code === PG_UNIQUE_VIOLATION || e.driverError?.code === PG_UNIQUE_VIOLATION;
}

export default fp(async function (fastify: FastifyInstance) {
  fastify.setErrorHandler(
    (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send({ error: error.message });
      }

      // Race-condition fallback: services pre-check uniqueness, the DB constraint is the backstop
      if (isUniqueViolation(error)) {
        return reply.status(409).send({ error: "Already exists" });
      }

      // Client errors (schema validation 400, rate limit 429, ...) keep their status and message
      const statusCode = error.statusCode ?? 500;
      if (statusCode < 500) {
        return reply.status(statusCode).send({ error: error.message });
      }

      request.log.error(error);
      return reply.status(500).send({ error: "Internal Server Error" });
    }
  );
});
