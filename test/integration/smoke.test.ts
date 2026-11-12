import { test } from "node:test";
import assert from "node:assert/strict";
import { send, useTestApp } from "./helpers";

const getApp = useTestApp();

test("GET /users/me without a token returns 401", async () => {
  const res = await send(getApp(), { method: "GET", url: "/users/me" });
  assert.equal(res.statusCode, 401);
});
