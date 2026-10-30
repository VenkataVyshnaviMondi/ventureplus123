import { PrismaClient } from "@prisma/client";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { prepareDatabaseUrl } from "./tidb-tls.js";

// Synchronous validation and atomic CA installation finish before construction.
const databaseUrl = prepareDatabaseUrl(env.databaseUrl, {
  vercelEnv: process.env.VERCEL_ENV,
  caBase64: process.env.TIDB_CA_CERT_BASE64,
  stagingDbUser: process.env.TIDB_STAGING_DB_USER
});

export const prisma = new PrismaClient({
  datasources: {
    db: {
      url: databaseUrl
    }
  },
  log: env.nodeEnv === "development" ? ["warn", "error"] : ["error"]
});

process.on("beforeExit", async () => {
  try {
    await prisma.$disconnect();
  } catch (error) {
    logger.error({ error }, "Failed to disconnect Prisma");
  }
});
