import "reflect-metadata";

async function main() {
  // Loaded lazily: importing config validates the environment and may throw a ConfigError,
  // which must be caught below rather than surface as an uncaught module-load exception.
  const { config } = await import("./config");
  const { AppDataSource } = await import("./data-source");
  const { buildApp } = await import("./app");

  await AppDataSource.initialize();
  console.log("Database connected");

  const app = await buildApp({ dataSource: AppDataSource });

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    try {
      await app.close();
      await AppDataSource.destroy();
      process.exit(0);
    } catch (err) {
      app.log.error(err);
      process.exit(1);
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
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
