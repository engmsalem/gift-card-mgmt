import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadConfig,
  loadDbConfig,
  loadDispatchConfig,
  loadServerConfig,
  PUBLISHED_NON_SECRET_KEYS,
} from "../../src/config";

const validEnv = {
  DB_DATABASE: "gcm",
  DB_USERNAME: "app",
  DB_PASSWORD: "app-pass",
  JWT_SECRET: "x".repeat(32),
  CARD_ENCRYPTION_KEY: PUBLISHED_NON_SECRET_KEYS.testEncryption,
  CARD_LOOKUP_KEY: PUBLISHED_NON_SECRET_KEYS.testLookup,
};

// Non-published keys with many distinct byte values, as an operator would generate them
const prodEnv = {
  ...validEnv,
  NODE_ENV: "production",
  CARD_ENCRYPTION_KEY: "a3f1c97b2e5d4086b1c2d3e4f5061728394a5b6c7d8e9f00112233445566778a",
  CARD_LOOKUP_KEY: "5b8e1d0c9f7a6e4d3c2b1a0918273645546372819a0b1c2d3e4f5a6b7c8d9e0f",
  GIFT_CARD_LINK_BASE_URL: "https://gifts.example.com/gift",
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
  const prod = prodEnv;
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

test("PATCH is in the default CORS methods", () => {
  assert.deepEqual(loadConfig(validEnv).corsMethods, ["GET", "POST", "PUT", "PATCH", "DELETE"]);
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

test("loadDbConfig needs only DB vars: no JWT_SECRET or CORS_ORIGIN even in production", () => {
  const cfg = loadDbConfig({
    NODE_ENV: "production",
    DB_DATABASE: "gcm",
    DB_USERNAME: "app",
    DB_PASSWORD: "app-pass",
    DB_ADMIN_USERNAME: "owner",
    DB_ADMIN_PASSWORD: "owner-pass",
  });
  assert.equal(cfg.dbDatabase, "gcm");
  assert.equal(cfg.dbAdminUsername, "owner");
  assert.ok(Object.isFrozen(cfg));
  assert.ok(!("nodeEnv" in cfg), "NODE_ENV belongs to the server config only");
  assert.throws(() => loadDbConfig({}), (err: Error) => {
    assert.match(err.message, /DB_DATABASE/);
    assert.doesNotMatch(err.message, /JWT_SECRET|CORS_/);
    return true;
  });
});

test("loadServerConfig errors name only server vars", () => {
  assert.throws(() => loadServerConfig({ NODE_ENV: "production" }), (err: Error) => {
    assert.match(err.message, /JWT_SECRET/);
    assert.match(err.message, /CORS_ORIGIN is required/);
    assert.doesNotMatch(err.message, /DB_/);
    return true;
  });
  const cfg = loadServerConfig({ JWT_SECRET: "x".repeat(32), PORT: "4000" });
  assert.equal(cfg.port, 4000);
  assert.equal(cfg.nodeEnv, "development");
  assert.equal(cfg.corsOrigin, "*");
});

test("loadConfig reports database and server problems together in one error", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production", PORT: "abc" }), (err: Error) => {
    for (const name of ["DB_DATABASE", "DB_USERNAME", "JWT_SECRET", "CORS_ORIGIN", "PORT"]) {
      assert.match(err.message, new RegExp(name));
    }
    return true;
  });
});

const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  return assert.fail("expected a ConfigError");
};

const omit = (env: Record<string, string>, name: string): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter(([key]) => key !== name));

const prodWithCors = { ...prodEnv, CORS_ORIGIN: "https://a.example" };

test("card keys are required, and loadConfig applies card defaults", () => {
  const withoutKeys = omit(omit(validEnv, "CARD_ENCRYPTION_KEY"), "CARD_LOOKUP_KEY");
  const message = messageOf(() => loadConfig(withoutKeys));
  assert.match(message, /CARD_ENCRYPTION_KEY is required/);
  assert.match(message, /CARD_LOOKUP_KEY is required/);

  const cfg = loadConfig(validEnv);
  assert.equal(cfg.cardEncryptionKey.id, 1);
  assert.equal(cfg.cardLookupKey.id, 1);
  assert.equal(cfg.cardEncryptionKey.key.toString("hex"), PUBLISHED_NON_SECRET_KEYS.testEncryption);
  assert.equal(cfg.giftCardLinkBaseUrl, "http://localhost:3000/gift");
  assert.equal(cfg.giftCardDevPrintLinks, false);
});

test("non-hex, wrong-length and low-entropy keys are rejected without echoing the value", () => {
  const lowEntropy = "0123456789abcdef".repeat(4); // 8 distinct bytes
  const bad = ["z".repeat(64), "ab".repeat(31), "ab".repeat(33), lowEntropy, "00".repeat(32)];
  for (const value of bad) {
    const message = messageOf(() => loadConfig({ ...validEnv, CARD_ENCRYPTION_KEY: value }));
    assert.match(message, /CARD_ENCRYPTION_KEY/);
    assert.ok(!message.includes(value), "the error must not echo the key");
  }
  assert.match(messageOf(() => loadConfig({ ...validEnv, CARD_ENCRYPTION_KEY: lowEntropy })), /low-entropy/);
  assert.match(messageOf(() => loadConfig({ ...validEnv, CARD_LOOKUP_KEY: lowEntropy })), /CARD_LOOKUP_KEY is too low-entropy/);
});

test("every published key passes the 16-distinct-byte rule", () => {
  for (const hex of Object.values(PUBLISHED_NON_SECRET_KEYS)) {
    assert.ok(new Set(Buffer.from(hex, "hex")).size >= 16);
  }
  const cfg = loadConfig({
    ...validEnv,
    CARD_ENCRYPTION_KEY: PUBLISHED_NON_SECRET_KEYS.ciEncryption,
    CARD_LOOKUP_KEY: PUBLISHED_NON_SECRET_KEYS.ciLookup,
  });
  assert.equal(cfg.cardEncryptionKey.key.length, 32);
});

test("the encryption and lookup keys must differ", () => {
  const message = messageOf(() => loadConfig({ ...validEnv, CARD_LOOKUP_KEY: validEnv.CARD_ENCRYPTION_KEY }));
  assert.match(message, /CARD_LOOKUP_KEY must differ from CARD_ENCRYPTION_KEY/);
  assert.ok(!message.includes(validEnv.CARD_ENCRYPTION_KEY));
});

test("card key ids must be integers from 1 to 32767", () => {
  assert.equal(loadConfig({ ...validEnv, CARD_ENCRYPTION_KEY_ID: "32767" }).cardEncryptionKey.id, 32767);
  assert.equal(loadConfig({ ...validEnv, CARD_LOOKUP_KEY_ID: "2" }).cardLookupKey.id, 2);
  for (const id of ["0", "32768", "-1", "1.5", "abc"]) {
    assert.match(messageOf(() => loadConfig({ ...validEnv, CARD_ENCRYPTION_KEY_ID: id })), /CARD_ENCRYPTION_KEY_ID must be/);
    assert.match(messageOf(() => loadConfig({ ...validEnv, CARD_LOOKUP_KEY_ID: id })), /CARD_LOOKUP_KEY_ID must be/);
  }
});

test("published keys are refused in production and accepted in test", () => {
  assert.ok(loadConfig({ ...validEnv, NODE_ENV: "test" }));
  assert.ok(loadConfig(prodWithCors));
  assert.match(
    messageOf(() =>
      loadConfig({ ...prodWithCors, CARD_ENCRYPTION_KEY: PUBLISHED_NON_SECRET_KEYS.ciEncryption.toUpperCase() })
    ),
    /CARD_ENCRYPTION_KEY is a published test\/CI key/
  );
  assert.match(
    messageOf(() => loadConfig({ ...prodWithCors, CARD_LOOKUP_KEY: PUBLISHED_NON_SECRET_KEYS.testLookup })),
    /CARD_LOOKUP_KEY is a published test\/CI key/
  );
});

test("DB_LOGGING=true is refused in production only", () => {
  assert.match(messageOf(() => loadConfig({ ...prodWithCors, DB_LOGGING: "true" })), /DB_LOGGING=true is not allowed/);
  assert.equal(loadConfig({ ...validEnv, DB_LOGGING: "true" }).dbLogging, true);
  assert.equal(loadConfig({ ...prodWithCors, DB_LOGGING: "false" }).dbLogging, false);
});

test("GIFT_CARD_LINK_BASE_URL: required and https in production, no fragment anywhere", () => {
  const withoutUrl = omit(prodWithCors, "GIFT_CARD_LINK_BASE_URL");
  assert.match(messageOf(() => loadConfig(withoutUrl)), /GIFT_CARD_LINK_BASE_URL is required/);
  assert.match(
    messageOf(() => loadConfig({ ...prodWithCors, GIFT_CARD_LINK_BASE_URL: "http://gifts.example.com/gift" })),
    /GIFT_CARD_LINK_BASE_URL must use https/
  );
  for (const url of ["https://gifts.example.com/gift#x", "https://gifts.example.com/gift#"]) {
    assert.match(
      messageOf(() => loadConfig({ ...validEnv, GIFT_CARD_LINK_BASE_URL: url })),
      /must not contain a fragment/
    );
  }
  assert.match(messageOf(() => loadConfig({ ...validEnv, GIFT_CARD_LINK_BASE_URL: "not a url" })), /valid URL/);
  assert.match(messageOf(() => loadConfig({ ...validEnv, GIFT_CARD_LINK_BASE_URL: "ftp://x.example/g" })), /http\(s\) URL/);
  assert.equal(
    loadConfig({ ...validEnv, GIFT_CARD_LINK_BASE_URL: "http://localhost:8080/g" }).giftCardLinkBaseUrl,
    "http://localhost:8080/g"
  );
});

test("GIFT_CARD_DEV_PRINT_LINKS=true is allowed only in development", () => {
  // NODE_ENV defaults to development
  assert.equal(loadConfig({ ...validEnv, GIFT_CARD_DEV_PRINT_LINKS: "true" }).giftCardDevPrintLinks, true);
  assert.equal(
    loadConfig({ ...validEnv, NODE_ENV: "development", GIFT_CARD_DEV_PRINT_LINKS: "true" }).giftCardDevPrintLinks,
    true
  );
  for (const nodeEnv of ["test", "production"]) {
    assert.match(
      messageOf(() => loadConfig({ ...prodWithCors, NODE_ENV: nodeEnv, GIFT_CARD_DEV_PRINT_LINKS: "true" })),
      /GIFT_CARD_DEV_PRINT_LINKS=true is allowed only/
    );
  }
});

test("loadServerConfig still needs no card keys", () => {
  const cfg = loadServerConfig({ JWT_SECRET: "x".repeat(32) });
  assert.ok(!("cardEncryptionKey" in cfg));
});

test("loadConfig reports card key, link and logging problems together with the rest", () => {
  const message = messageOf(() =>
    loadConfig({ NODE_ENV: "production", DB_LOGGING: "true", CARD_ENCRYPTION_KEY: "short" })
  );
  for (const name of [
    "DB_DATABASE",
    "JWT_SECRET",
    "CORS_ORIGIN",
    "CARD_ENCRYPTION_KEY",
    "CARD_LOOKUP_KEY",
    "GIFT_CARD_LINK_BASE_URL",
    "DB_LOGGING",
  ]) {
    assert.match(message, new RegExp(name));
  }
});

test("loadDispatchConfig needs DB vars and the link URL, not card keys or API secrets", () => {
  const env = { DB_DATABASE: "gcm", DB_USERNAME: "app", DB_PASSWORD: "app-pass" };
  const cfg = loadDispatchConfig(env);
  assert.equal(cfg.dbDatabase, "gcm");
  assert.equal(cfg.giftCardLinkBaseUrl, "http://localhost:3000/gift");
  assert.equal(cfg.giftCardDevPrintLinks, false);
  assert.equal(cfg.nodeEnv, "development");
  assert.ok(Object.isFrozen(cfg));
  assert.ok(!("cardEncryptionKey" in cfg));

  const prodMessage = messageOf(() => loadDispatchConfig({ ...env, NODE_ENV: "production", DB_LOGGING: "true" }));
  assert.match(prodMessage, /GIFT_CARD_LINK_BASE_URL is required/);
  assert.match(prodMessage, /DB_LOGGING=true is not allowed/);
  assert.doesNotMatch(prodMessage, /JWT_SECRET|CARD_ENCRYPTION|CARD_LOOKUP/);
  assert.match(
    messageOf(() => loadDispatchConfig({ ...env, NODE_ENV: "test", GIFT_CARD_DEV_PRINT_LINKS: "true" })),
    /GIFT_CARD_DEV_PRINT_LINKS=true is allowed only/
  );
  assert.equal(
    loadDispatchConfig({ ...env, NODE_ENV: "production", GIFT_CARD_LINK_BASE_URL: "https://gifts.example.com/gift" }).nodeEnv,
    "production"
  );
});

test("NODE_ENV accepts only development, test and production; unset or empty is development", () => {
  const dispatchEnv = { DB_DATABASE: "gcm", DB_USERNAME: "app", DB_PASSWORD: "app-pass" };
  assert.equal(loadConfig(validEnv).nodeEnv, "development");
  assert.equal(loadConfig({ ...validEnv, NODE_ENV: "" }).nodeEnv, "development");
  assert.equal(loadDispatchConfig(dispatchEnv).nodeEnv, "development");
  assert.equal(loadServerConfig({ JWT_SECRET: "x".repeat(32) }).nodeEnv, "development");
  for (const value of ["development", "test"]) {
    assert.equal(loadConfig({ ...validEnv, NODE_ENV: value }).nodeEnv, value);
    assert.equal(loadDispatchConfig({ ...dispatchEnv, NODE_ENV: value }).nodeEnv, value);
  }
  assert.equal(loadConfig({ ...prodEnv, CORS_ORIGIN: "https://app.example.com" }).nodeEnv, "production");

  for (const value of ["Production", "prod", "staging", " production"]) {
    const apiMessage = messageOf(() => loadConfig({ ...prodEnv, NODE_ENV: value }));
    assert.match(apiMessage, /NODE_ENV must be one of development, test, production/, value);
    assert.equal(apiMessage.match(/NODE_ENV must be/g)?.length, 1, "reported once");
    assert.match(
      messageOf(() => loadDispatchConfig({ ...dispatchEnv, NODE_ENV: value })),
      /NODE_ENV must be one of development, test, production/,
      value
    );
    assert.match(
      messageOf(() => loadServerConfig({ JWT_SECRET: "x".repeat(32), NODE_ENV: value })),
      /NODE_ENV must be one of/,
      value
    );
  }
});
