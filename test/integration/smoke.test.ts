import { test } from "node:test";
import assert from "node:assert/strict";
import { send, useTestApp } from "./helpers";

const getApp = useTestApp();

test("GET /users/me without a token returns 401", async () => {
  const res = await send(getApp(), { method: "GET", url: "/users/me" });
  assert.equal(res.statusCode, 401);
});

test("a cross-origin response exposes the headers browser clients need to read", async () => {
  const res = await send(getApp(), {
    method: "GET",
    url: "/users/me",
    headers: { origin: "https://app.example.com" },
  });
  const exposed = String(res.headers["access-control-expose-headers"]).toLowerCase();
  assert.ok(exposed.includes("idempotent-replayed"), exposed);
  assert.ok(exposed.includes("retry-after"), exposed);
});
