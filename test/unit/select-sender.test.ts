import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, loadDispatchConfig } from "../../src/config";
import { ConsoleLinkDeliverySender } from "../../src/delivery/console-link-sender";
import { LogOnlyDeliverySender } from "../../src/delivery/log-only-sender";
import { selectDeliverySender } from "../../src/delivery/select-sender";
import type { GiftCardDeliverySender } from "../../src/services/deliveryDispatcher";

const log = { info: () => undefined };
const override: GiftCardDeliverySender = { send: () => Promise.resolve() };

function refusal(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ConfigError, "a ConfigError, so the dispatch script prints just the message");
    return err;
  }
  assert.fail("expected a ConfigError");
}

test("production without an override: refuses, naming the problem", () => {
  const err = refusal(() => selectDeliverySender({ nodeEnv: "production", devPrintLinks: false, log }));
  assert.match(err.message, /no provider configured/);
  assert.match(err.message, /mark gift card emails as sent without delivering them/);
});

test("production with an injected sender uses it", () => {
  assert.equal(selectDeliverySender({ override, nodeEnv: "production", devPrintLinks: false, log }), override);
});

test("the override wins over the development console sender", () => {
  assert.equal(selectDeliverySender({ override, nodeEnv: "development", devPrintLinks: true, log }), override);
});

test("development with GIFT_CARD_DEV_PRINT_LINKS: the console sender", () => {
  const sender = selectDeliverySender({ nodeEnv: "development", devPrintLinks: true, log });
  assert.ok(sender instanceof ConsoleLinkDeliverySender);
});

test("outside production without an override: the log-only sender", () => {
  for (const nodeEnv of ["development", "test", "staging"]) {
    const sender = selectDeliverySender({ nodeEnv, devPrintLinks: false, log });
    assert.ok(sender instanceof LogOnlyDeliverySender, nodeEnv);
  }
});

// The dispatch script feeds the selection from loadDispatchConfig and has no override
test("dispatch script path: production config refuses, development and test do not", () => {
  const base = { DB_DATABASE: "gcm", DB_USERNAME: "app", DB_PASSWORD: "app-pass" };
  const fromEnv = (env: Record<string, string>) => {
    const config = loadDispatchConfig({ ...base, ...env });
    return selectDeliverySender({ nodeEnv: config.nodeEnv, devPrintLinks: config.giftCardDevPrintLinks, log });
  };
  refusal(() => fromEnv({ NODE_ENV: "production", GIFT_CARD_LINK_BASE_URL: "https://gifts.example.com/gift" }));
  assert.ok(fromEnv({ NODE_ENV: "development" }) instanceof LogOnlyDeliverySender);
  assert.ok(fromEnv({ NODE_ENV: "development", GIFT_CARD_DEV_PRINT_LINKS: "true" }) instanceof ConsoleLinkDeliverySender);
  assert.ok(fromEnv({ NODE_ENV: "test" }) instanceof LogOnlyDeliverySender);
});
