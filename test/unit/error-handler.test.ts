import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify, { FastifyInstance } from "fastify";
import errorHandler from "../../src/plugins/error-handler";
import { CardCryptoError } from "../../src/gift-cards/card-crypto";
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "../../src/errors";

async function appThrowing(error: unknown): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(errorHandler);
  app.get("/boom", () => {
    throw error;
  });
  app.post(
    "/validated",
    { schema: { body: { type: "object", required: ["a"], properties: { a: { type: "string" } } } } },
    () => ({ ok: true })
  );
  return app;
}

test("AppError subclasses map to their status and message", async () => {
  const cases: [AppError, number][] = [
    [new AppError(418, "teapot"), 418],
    [new BadRequestError("bad"), 400],
    [new UnauthorizedError("nope"), 401],
    [new ForbiddenError("no"), 403],
    [new NotFoundError("gone"), 404],
    [new ConflictError("dup"), 409],
  ];
  for (const [error, status] of cases) {
    const app = await appThrowing(error);
    const res = await app.inject({ method: "GET", url: "/boom" });
    assert.equal(res.statusCode, status);
    assert.deepEqual(res.json(), { error: error.message });
    await app.close();
  }
});

test("Fastify client errors (schema validation) keep their 4xx status", async () => {
  const app = await appThrowing(new Error("unused"));
  const res = await app.inject({ method: "POST", url: "/validated", payload: {} });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ error: string }>().error, /required/);
  await app.close();
});

test("Postgres unique violations map to 409", async () => {
  for (const error of [
    Object.assign(new Error("duplicate key value"), { code: "23505" }),
    Object.assign(new Error("query failed"), { driverError: { code: "23505" } }),
  ]) {
    const app = await appThrowing(error);
    const res = await app.inject({ method: "GET", url: "/boom" });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), { error: "Already exists" });
    await app.close();
  }
});

test("unknown errors return a generic 500 without leaking the message", async () => {
  const app = await appThrowing(new Error("secret internal detail: password=hunter2"));
  const res = await app.inject({ method: "GET", url: "/boom" });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.json(), { error: "Internal Server Error" });
  assert.ok(!res.body.includes("hunter2"));
  await app.close();
});

test("other Postgres errors are not treated as conflicts", async () => {
  const app = await appThrowing(Object.assign(new Error("fk violation"), { code: "23503" }));
  const res = await app.inject({ method: "GET", url: "/boom" });
  assert.equal(res.statusCode, 500);
  await app.close();
});

test("Postgres deadlock, serialization and lock-timeout failures map to 503 with Retry-After", async () => {
  for (const error of [
    Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }),
    Object.assign(new Error("query failed"), { driverError: { code: "55P03" } }),
    Object.assign(new Error("deadlock detected"), { code: "40P01" }),
    Object.assign(new Error("could not serialize access"), { code: "40001" }),
    Object.assign(new Error("query failed"), { driverError: { code: "40P01" } }),
    Object.assign(new Error("query failed"), { driverError: { code: "40001" } }),
  ]) {
    const app = await appThrowing(error);
    const res = await app.inject({ method: "GET", url: "/boom" });
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers["retry-after"], "1");
    assert.deepEqual(res.json(), { error: "Temporary conflict, please retry" });
    await app.close();
  }
});

// ---------- what is logged (design 7.9) ----------

async function logsFor(error: unknown): Promise<{ status: number; lines: Record<string, unknown>[]; raw: string }> {
  const chunks: string[] = [];
  const app = Fastify({ logger: { level: "trace", stream: { write: (line: string) => void chunks.push(line) } } });
  await app.register(errorHandler);
  app.get("/boom", () => {
    throw error;
  });
  const res = await app.inject({ method: "GET", url: "/boom" });
  await app.close();
  const raw = chunks.join("");
  return { status: res.statusCode, raw, lines: chunks.map((c) => JSON.parse(c) as Record<string, unknown>) };
}

function queryFailed(code: string): Error {
  // The shape of TypeORM's QueryFailedError over node-postgres
  return Object.assign(new Error('insert into x values ($1) -- marker@example.com'), {
    name: "QueryFailedError",
    query: "INSERT INTO gift_card_deliveries (recipient_email) VALUES ($1)",
    parameters: ["marker@example.com", "4111111111111111"],
    driverError: Object.assign(new Error("Failing row contains (marker@example.com)"), {
      code,
      detail: "Failing row contains (marker@example.com)",
      where: "SQL statement with 4111111111111111",
      constraint: "gift_card_deliveries_status_check",
      table: "gift_card_deliveries",
    }),
    code,
    detail: "Failing row contains (marker@example.com)",
  });
}

test("a database error on the 500 path is logged as name, code, constraint and table only", async () => {
  const { status, lines, raw } = await logsFor(queryFailed("23514"));
  assert.equal(status, 500);
  const line = lines.find((l) => l.msg === "request failed");
  assert.ok(line, raw);
  assert.deepEqual(line.err, {
    name: "QueryFailedError",
    code: "23514",
    constraint: "gift_card_deliveries_status_check",
    table: "gift_card_deliveries",
  });
  assert.ok(!raw.includes("marker@example.com") && !raw.includes("4111111111111111"), raw);
});

test("a database error on the 503 path is logged the same way", async () => {
  const { status, lines, raw } = await logsFor(queryFailed("55P03"));
  assert.equal(status, 503);
  const line = lines.find((l) => l.msg === "retryable database conflict");
  assert.ok(line, raw);
  assert.equal((line.err as { code: string }).code, "55P03");
  assert.ok(!raw.includes("marker@example.com") && !raw.includes("4111111111111111"), raw);
});

test("a CardCryptoError returns a generic 500 and logs the card id with its fixed message", async () => {
  const { status, lines, raw } = await logsFor(new CardCryptoError("Decryption failed", "card-123"));
  assert.equal(status, 500);
  const line = lines.find((l) => l.msg === "card decryption failed");
  assert.ok(line, raw);
  const err = line.err as { name: string; message: string; stack: string };
  assert.equal(err.name, "CardCryptoError");
  assert.equal(err.message, "Decryption failed");
  assert.equal(line.cardId, "card-123");
  assert.equal(err.stack, "", "no stack");
});

test("an error with a database cause logs the cause reduced, not whole", async () => {
  const { lines, raw } = await logsFor(new Error("card number collision", { cause: queryFailed("23505") }));
  const line = lines.find((l) => l.msg === "request failed");
  assert.ok(line, raw);
  const err = line.err as { message: string; cause: Record<string, unknown> };
  assert.equal(err.message, "card number collision");
  assert.equal(err.cause.code, "23505");
  assert.ok(!raw.includes("marker@example.com") && !raw.includes("4111111111111111"), raw);
});
