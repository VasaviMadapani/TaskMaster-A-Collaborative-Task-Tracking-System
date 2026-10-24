import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { app } from "./app";
import { config } from "./config";
import { prisma } from "./db";
import { logger } from "./logger";

async function start(): Promise<void> {
  await mkdir(config.UPLOAD_DIR, { recursive: true });
  await prisma.$connect();
  const server = createServer(app);

  server.listen(config.PORT, () => {
    logger.info({ port: config.PORT, environment: config.NODE_ENV }, "TaskMaster API listening");
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Graceful shutdown started");
    server.close((error) => {
      if (error) {
        logger.error({ err: error }, "HTTP server failed to close cleanly");
        process.exitCode = 1;
      }
      void prisma.$disconnect().catch((disconnectError: unknown) => {
        logger.error({ err: disconnectError }, "Database disconnect failed");
        process.exitCode = 1;
      });
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch(async (error: unknown) => {
  logger.fatal({ err: error }, "Application startup failed");
  await prisma.$disconnect();
  process.exitCode = 1;
});
