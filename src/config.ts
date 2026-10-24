import "dotenv/config";
import { z } from "zod";

const booleanFromEnv = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  WEB_ORIGINS: z.string().default("http://localhost:5173"),
  COOKIE_SECURE: booleanFromEnv,
  UPLOAD_DIR: z.string().default("./uploads"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(1).max(104857600).default(10485760),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

const result = envSchema.safeParse(process.env);
if (!result.success) {
  throw new Error(`Invalid environment configuration: ${z.prettifyError(result.error)}`);
}

export const config = {
  ...result.data,
  webOrigins: result.data.WEB_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
  refreshTokenTtlMs: result.data.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  isProduction: result.data.NODE_ENV === "production",
};
