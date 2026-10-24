import type { RequestHandler } from "express";
import type { ZodType } from "zod";

export function validateBody<T>(schema: ZodType<T>): RequestHandler {
  return (req, _res, next) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function validateParams<T>(schema: ZodType<T>): RequestHandler {
  return (req, _res, next) => {
    try {
      schema.parse(req.params);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function validateQuery<T>(schema: ZodType<T>): RequestHandler {
  return (req, _res, next) => {
    try {
      schema.parse(req.query);
      next();
    } catch (error) {
      next(error);
    }
  };
}
