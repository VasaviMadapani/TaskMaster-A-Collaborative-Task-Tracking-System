import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { config } from "./config";
import { prisma } from "./db";
import { logger } from "./logger";
import { errorHandler, notFoundHandler } from "./middleware/errors";
import authRoutes from "./routes/auth";
import assignedTaskRoutes from "./routes/assigned-tasks";
import projectRoutes from "./routes/projects";
import taskRoutes from "./routes/tasks";
import userRoutes from "./routes/users";

export const app = express();
const apiRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many requests; try again later" } },
});
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many authentication requests; try again later" } },
});

app.disable("x-powered-by");
if (config.TRUST_PROXY_HOPS > 0) app.set("trust proxy", config.TRUST_PROXY_HOPS);
app.use(helmet());
app.use(cors({
  credentials: true,
  origin: (origin, callback) => callback(null, !origin || config.webOrigins.includes(origin)),
}));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(pinoHttp({ logger }));
app.use(apiRateLimit);

app.get("/health/live", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/health/ready", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ready" });
  } catch (error) {
    logger.error({ err: error }, "Readiness check failed");
    res.status(503).json({ status: "not-ready" });
  }
});

app.use("/api/v1/auth", authRateLimit, authRoutes);
app.use("/api/v1/users", userRoutes);
app.use("/api/v1/tasks", assignedTaskRoutes);
app.use("/api/v1/projects", projectRoutes);
app.use("/api/v1/projects", taskRoutes);
app.use(notFoundHandler);
app.use(errorHandler);
