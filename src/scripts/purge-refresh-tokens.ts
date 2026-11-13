import "dotenv/config";
import "reflect-metadata";
import { DataSource } from "typeorm";
import { loadDbConfig } from "../config";
import { createDataSource } from "../data-source";
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
  const dataSource = createDataSource(loadDbConfig(process.env), "app");
  await dataSource.initialize();
  try {
    const purged = await purgeExpiredRefreshTokens(dataSource);
    console.log(`Purged ${purged} expired refresh tokens`);
  } finally {
    await dataSource.destroy();
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
