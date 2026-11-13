import fp from "fastify-plugin";
import { FastifyInstance, FastifyRequest, FastifyReply, FastifyError } from "fastify";
import { AppError } from "../errors";
import { CardCryptoError } from "../gift-cards/card-crypto";

const PG_UNIQUE_VIOLATION = "23505";
const PG_SERIALIZATION_FAILURE = "40001";
const PG_DEADLOCK_DETECTED = "40P01";
const PG_LOCK_NOT_AVAILABLE = "55P03"; // lock_timeout expired

// TypeORM's QueryFailedError copies the driver error's fields onto itself and also keeps
// the original under `driverError`.
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; driverError?: { code?: unknown } };
  return e.code === PG_UNIQUE_VIOLATION || e.driverError?.code === PG_UNIQUE_VIOLATION;
}

// A transaction the database aborted (or gave up waiting for a lock in) because of a concurrent
// one; safe for the client to retry
function isRetryableConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; driverError?: { code?: unknown } };
  return [e.code, e.driverError?.code].some(
    (code) => code === PG_DEADLOCK_DETECTED || code === PG_SERIALIZATION_FAILURE || code === PG_LOCK_NOT_AVAILABLE
  );
}

// A five character SQLSTATE; Node and Fastify error codes (ECONNREFUSED, FST_ERR_...) do not match
const SQLSTATE = /^[0-9A-Z]{5}$/;

type DriverFields = { code?: unknown; constraint?: unknown; table?: unknown; driverError?: DriverFields };

function stringField(error: DriverFields, field: "code" | "constraint" | "table"): string | undefined {
  const own = error[field];
  if (typeof own === "string") return own;
  const driver = error.driverError?.[field];
  return typeof driver === "string" ? driver : undefined;
}

// What a log line may say about an error (design 7.9). A database error is reduced to its class and
// the code, constraint and table: its message, detail, query and parameters can carry row data and
// request values (a card number, a recipient email). Anything else keeps its name, message and
// stack, plus its cause reduced the same way; its other properties are dropped.
function loggableError(error: unknown, depth = 0): Record<string, unknown> {
  if (typeof error !== "object" || error === null) return { name: typeof error };
  const e = error as Error & DriverFields & { cause?: unknown };
  const name = typeof e.name === "string" ? e.name : "Error";
  const code = stringField(e, "code");
  if ((code !== undefined && SQLSTATE.test(code)) || e.driverError !== undefined) {
    return { name, code, constraint: stringField(e, "constraint"), table: stringField(e, "table") };
  }
  const reduced: Record<string, unknown> = { name, message: e.message, stack: e.stack };
  if (e.cause !== undefined && depth < 1) reduced.cause = loggableError(e.cause, depth + 1);
  return reduced;
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

      // Concurrent-transaction aborts (deadlock, serialization failure) and lock timeouts
      if (isRetryableConflict(error)) {
        request.log.warn({ err: loggableError(error) }, "retryable database conflict");
        return reply
          .status(503)
          .header("Retry-After", "1")
          .send({ error: "Temporary conflict, please retry" });
      }

      // Client errors (schema validation 400, rate limit 429, ...) keep their status and message
      const statusCode = error.statusCode ?? 500;
      if (statusCode < 500) {
        return reply.status(statusCode).send({ error: error.message });
      }

      // A CardCryptoError message is fixed text; the card id is the only thing logged about the card
      const thrown: unknown = error;
      if (thrown instanceof CardCryptoError) {
        request.log.error(
          { err: { name: thrown.name, message: thrown.message }, cardId: thrown.cardId },
          "card decryption failed"
        );
      } else {
        request.log.error({ err: loggableError(error) }, "request failed");
      }
      return reply.status(500).send({ error: "Internal Server Error" });
    }
  );
});
