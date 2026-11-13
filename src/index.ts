import "dotenv/config";
import "reflect-metadata";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { createDataSource } from "./data-source";

async function main() {
  // Throws a ConfigError on a bad environment; handled by the catch below
  const config = loadConfig(process.env);
  const dataSource = createDataSource(config, "app");

  await dataSource.initialize();
  console.log("Database connected");

  try {
    // buildApp closes its own instance if registration fails
    const app = await buildApp({ config, dataSource });
    try {
      await app.listen({ host: config.host, port: config.port });
    } catch (err) {
      await app.close().catch(() => undefined);
      throw err;
    }

    // Only once listening: before that, a signal should simply end the process
    const shutdown = async (signal: string) => {
      app.log.info(`${signal} received, shutting down`);
      try {
        await app.close();
        await dataSource.destroy();
        process.exit(0);
      } catch (err) {
        app.log.error(err);
        process.exit(1);
      }
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  } catch (err) {
    // Startup failed after the pool opened (e.g. port in use): release the pool so the
    // process can exit, then let the handler below report the original error
    await dataSource.destroy().catch(() => undefined);
    throw err;
  }
}

main().catch((err) => {
  if (err instanceof Error && err.name === "ConfigError") {
    // Configuration mistakes are operator errors: the message names the variables, no stack needed
    console.error(err.message);
  } else {
    console.error("Startup failed:", err);
  }
  process.exit(1);
});
