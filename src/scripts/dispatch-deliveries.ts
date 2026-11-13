import "dotenv/config";
import "reflect-metadata";
import { loadDispatchConfig } from "../config";
import { createDataSource } from "../data-source";
import { ConsoleLinkDeliverySender } from "../delivery/console-link-sender";
import { LogOnlyDeliverySender } from "../delivery/log-only-sender";
import { DeliveryDispatcher, DispatcherLog } from "../services/deliveryDispatcher";

const BATCH_SIZE = 50;

// One JSON object per line on stdout, for the cron job's log collector
const jsonLog: DispatcherLog = {
  info: (o, m) => console.log(JSON.stringify({ level: "info", msg: m, ...o })),
  warn: (o, m) => console.log(JSON.stringify({ level: "warn", msg: m, ...o })),
};

/** Dispatches batches until a pass claims nothing. Returns how many deliveries it claimed. */
export async function dispatchAllDue(dispatcher: DeliveryDispatcher): Promise<number> {
  let total = 0;
  for (;;) {
    const claimed = await dispatcher.dispatch({ limit: BATCH_SIZE });
    if (claimed === 0) return total;
    total += claimed;
  }
}

async function main(): Promise<void> {
  const config = loadDispatchConfig(process.env);
  const dataSource = createDataSource(config, "app");
  await dataSource.initialize();
  try {
    const dispatcher = new DeliveryDispatcher({
      db: dataSource,
      // Development only: config refuses GIFT_CARD_DEV_PRINT_LINKS=true under any other NODE_ENV
      sender: config.giftCardDevPrintLinks ? new ConsoleLinkDeliverySender() : new LogOnlyDeliverySender(jsonLog),
      linkBaseUrl: config.giftCardLinkBaseUrl,
      log: jsonLog,
    });
    const claimed = await dispatchAllDue(dispatcher);
    jsonLog.info({ claimed }, "gift card delivery dispatch finished");
  } finally {
    await dataSource.destroy();
  }
}

if (require.main === module) {
  main().catch((err) => {
    if (err instanceof Error && err.name === "ConfigError") {
      console.error(err.message);
    } else {
      console.error("Delivery dispatch failed:", err instanceof Error ? err.name : "Error");
    }
    process.exit(1);
  });
}
