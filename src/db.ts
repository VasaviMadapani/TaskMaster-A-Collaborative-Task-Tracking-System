import { PrismaClient } from "@prisma/client";
import { logger } from "./logger";

export const prisma = new PrismaClient({
  log: [{ emit: "event", level: "error" }, { emit: "event", level: "warn" }],
});

prisma.$on("error", (event) => logger.error({ message: event.message }, "Database error"));
prisma.$on("warn", (event) => logger.warn({ message: event.message }, "Database warning"));
