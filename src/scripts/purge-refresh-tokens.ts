import "reflect-metadata";
import { DataSource } from "typeorm";
import { RefreshToken } from "../entities/refresh-token";

/**
 * Deletes every expired refresh token (revoked or not). Login only cleans up the logging-in
 * user's own rows, so rows of users who never come back are removed by running this
 * periodically (cron, scheduled task). Returns the number of rows deleted.
 */
export async function purgeExpiredRefreshTokens(dataSource: DataSource): Promise<number> {
  const result = await dataSource
    .createQueryBuilder()
    .delete()
    .from(RefreshToken)
    .where("expires_at < now()")
    .execute();
  return result.affected ?? 0;
}

async function main(): Promise<void> {
  // Loaded lazily so a ConfigError surfaces through the handler below
  const { AppDataSource } = await import("../data-source");
  await AppDataSource.initialize();
  try {
    const purged = await purgeExpiredRefreshTokens(AppDataSource);
    console.log(`Purged ${purged} expired refresh tokens`);
  } finally {
    await AppDataSource.destroy();
  }
}

if (require.main === module) {
  main().catch((err) => {
    if (err instanceof Error && err.name === "ConfigError") {
      console.error(err.message);
    } else {
      console.error("Purge failed:", err);
    }
    process.exit(1);
  });
}
