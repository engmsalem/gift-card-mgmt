import { test } from "node:test";
import assert from "node:assert/strict";

// config.ts validates process.env at import time, so provide a valid environment first.
const validEnv = {
  DB_DATABASE: "gcm",
  DB_USERNAME: "app",
  DB_PASSWORD: "app-pass",
  JWT_SECRET: "x".repeat(32),
};
Object.assign(process.env, validEnv);
// eslint-disable-next-line @typescript-eslint/no-require-imports -- must load after env is set; a static import would validate env first
const { loadConfig } = require("../../src/config") as typeof import("../../src/config");

test("loadConfig applies defaults and falls back to app creds for admin", () => {
  const cfg = loadConfig(validEnv);
  assert.equal(cfg.port, 3000);
  assert.equal(cfg.dbPort, 5432);
  assert.equal(cfg.dbLogging, false);
  assert.equal(cfg.trustProxy, false);
  assert.equal(cfg.corsOrigin, "*");
  assert.equal(cfg.dbAdminUsername, "app");
  assert.equal(cfg.dbAdminPassword, "app-pass");
  assert.ok(Object.isFrozen(cfg));
});

test("loadConfig rejects a short JWT_SECRET and names the variable", () => {
  assert.throws(
    () => loadConfig({ ...validEnv, JWT_SECRET: "tooshort10" }),
    /JWT_SECRET must be at least 32 characters/
  );
});

test("loadConfig reports every missing variable at once", () => {
  assert.throws(() => loadConfig({}), (err: Error) => {
    for (const name of ["DB_DATABASE", "DB_USERNAME", "DB_PASSWORD", "JWT_SECRET"]) {
      assert.match(err.message, new RegExp(name));
    }
    return true;
  });
});

test("loadConfig reads TRUST_PROXY as a boolean and rejects other values", () => {
  assert.equal(loadConfig({ ...validEnv, TRUST_PROXY: "true" }).trustProxy, true);
  assert.equal(loadConfig({ ...validEnv, TRUST_PROXY: "0" }).trustProxy, false);
  assert.throws(() => loadConfig({ ...validEnv, TRUST_PROXY: "yes" }), /TRUST_PROXY must be/);
});

test("CORS_ORIGIN: one value stays a string, several become a trimmed list", () => {
  assert.equal(loadConfig({ ...validEnv, CORS_ORIGIN: "https://a.example" }).corsOrigin, "https://a.example");
  assert.deepEqual(
    loadConfig({ ...validEnv, CORS_ORIGIN: "https://a.example, https://b.example," }).corsOrigin,
    ["https://a.example", "https://b.example"]
  );
  assert.throws(() => loadConfig({ ...validEnv, CORS_ORIGIN: " , " }), /CORS_ORIGIN must contain/);
});
