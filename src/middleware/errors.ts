import type { ErrorRequestHandler, RequestHandler } from "express";
import { Prisma } from "@prisma/client";
import multer from "multer";
import { ZodError } from "zod";
import { ApiError } from "../errors";
import { logger } from "../logger";

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
};

export const errorHandler: ErrorRequestHandler = (error: unknown, req, res, _next) => {
  if (error instanceof ApiError) {
    res.status(error.statusCode).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }

  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
    return;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      res.status(409).json({ error: { code: "CONFLICT", message: "A record with these values already exists" } });
      return;
    }
    if (error.code === "P2025") {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Resource not found" } });
      return;
    }
  }

  if (error instanceof multer.MulterError) {
    const isTooLarge = error.code === "LIMIT_FILE_SIZE";
    res.status(isTooLarge ? 413 : 400).json({
      error: {
        code: isTooLarge ? "FILE_TOO_LARGE" : "INVALID_UPLOAD",
        message: isTooLarge ? "Attachment exceeds the upload size limit" : "Invalid multipart upload",
      },
    });
    return;
  }

  if (typeof error === "object" && error !== null && "type" in error) {
    if (error.type === "entity.parse.failed") {
      res.status(400).json({ error: { code: "INVALID_JSON", message: "Request body contains invalid JSON" } });
      return;
    }
    if (error.type === "entity.too.large") {
      res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the size limit" } });
      return;
    }
  }

  logger.error({ err: error, method: req.method, path: req.path }, "Unhandled request error");
  res.status(500).json({
    error: { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred" },
  });
};
