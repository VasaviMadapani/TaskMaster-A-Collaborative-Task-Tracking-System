import type { NextFunction, Request, Response } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { config } from "../config";
import { unauthorized } from "../errors";

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const authorization = req.header("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    next(unauthorized());
    return;
  }

  try {
    const payload = jwt.verify(authorization.slice(7), config.JWT_ACCESS_SECRET, {
      algorithms: ["HS256"],
      issuer: "taskmaster-api",
      audience: "taskmaster-client",
    }) as JwtPayload;
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
      throw unauthorized("Invalid access token");
    }
    req.auth = { userId: payload.sub, email: payload.email };
    next();
  } catch {
    next(unauthorized("Invalid or expired access token"));
  }
}
