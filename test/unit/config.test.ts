import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config";

const validEnv = {
  DB_DATABASE: "gcm",
  DB_USERNAME: "app",
  DB_PASSWORD: "app-pass",
  JWT_SECRET: "x".repeat(32),
};

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

test("HOST defaults to localhost and can be overridden", () => {
  assert.equal(loadConfig(validEnv).host, "localhost");
  assert.equal(loadConfig({ ...validEnv, HOST: "0.0.0.0" }).host, "0.0.0.0");
});

test("in production CORS_ORIGIN must be set explicitly; elsewhere it defaults to *", () => {
  const prod = { ...validEnv, NODE_ENV: "production" };
  assert.throws(() => loadConfig(prod), /CORS_ORIGIN is required/);
  assert.throws(() => loadConfig({ ...prod, CORS_ORIGIN: "" }), /CORS_ORIGIN is required/);
  assert.equal(loadConfig({ ...prod, CORS_ORIGIN: "https://a.example" }).corsOrigin, "https://a.example");
  assert.equal(loadConfig({ ...validEnv, NODE_ENV: "test" }).corsOrigin, "*");
});

test("CORS_METHODS and CORS_ALLOWED_HEADERS must not parse to an empty list", () => {
  for (const raw of [",", " , "]) {
    assert.throws(() => loadConfig({ ...validEnv, CORS_METHODS: raw }), /CORS_METHODS must contain/);
    assert.throws(
      () => loadConfig({ ...validEnv, CORS_ALLOWED_HEADERS: raw }),
      /CORS_ALLOWED_HEADERS must contain/
    );
  }
  assert.deepEqual(loadConfig({ ...validEnv, CORS_METHODS: "GET, PATCH" }).corsMethods, ["GET", "PATCH"]);
});

test("CORS_ORIGIN: * must be used alone", () => {
  assert.throws(
    () => loadConfig({ ...validEnv, CORS_ORIGIN: "*, https://a.example" }),
    /CORS_ORIGIN "\*" must be used alone/
  );
  assert.equal(loadConfig({ ...validEnv, CORS_ORIGIN: "*" }).corsOrigin, "*");
});

test("DB_ADMIN_* are a pair: both unset falls back to the app credentials as a pair", () => {
  const cfg = loadConfig(validEnv);
  assert.equal(cfg.dbAdminUsername, validEnv.DB_USERNAME);
  assert.equal(cfg.dbAdminPassword, validEnv.DB_PASSWORD);
  // empty strings count as unset
  const empty = loadConfig({ ...validEnv, DB_ADMIN_USERNAME: "", DB_ADMIN_PASSWORD: "" });
  assert.equal(empty.dbAdminUsername, validEnv.DB_USERNAME);
  assert.equal(empty.dbAdminPassword, validEnv.DB_PASSWORD);
});

test("DB_ADMIN_* both set are used as given", () => {
  const cfg = loadConfig({ ...validEnv, DB_ADMIN_USERNAME: "owner", DB_ADMIN_PASSWORD: "owner-pass" });
  assert.equal(cfg.dbAdminUsername, "owner");
  assert.equal(cfg.dbAdminPassword, "owner-pass");
});

test("DB_ADMIN_* exactly one set is a ConfigError naming the missing one", () => {
  assert.throws(
    () => loadConfig({ ...validEnv, DB_ADMIN_USERNAME: "owner" }),
    /DB_ADMIN_PASSWORD is required when DB_ADMIN_USERNAME is set/
  );
  assert.throws(
    () => loadConfig({ ...validEnv, DB_ADMIN_PASSWORD: "owner-pass" }),
    /DB_ADMIN_USERNAME is required when DB_ADMIN_PASSWORD is set/
  );
  assert.throws(
    () => loadConfig({ ...validEnv, DB_ADMIN_USERNAME: "owner", DB_ADMIN_PASSWORD: "" }),
    /DB_ADMIN_PASSWORD is required/
  );
});
