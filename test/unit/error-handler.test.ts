import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify, { FastifyInstance } from "fastify";
import errorHandler from "../../src/plugins/error-handler";
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

test("Postgres deadlock and serialization failures map to 503 with Retry-After", async () => {
  for (const error of [
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
