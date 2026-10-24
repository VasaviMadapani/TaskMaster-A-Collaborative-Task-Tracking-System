import { Router } from "express";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import type { Response } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { config } from "../config";
import { conflict, unauthorized } from "../errors";
import { authenticate } from "../middleware/authenticate";
import { validateBody } from "../middleware/validate";

const router = Router();
const refreshCookieName = "taskmaster_refresh";
const emailSchema = z.string().trim().email().max(320).transform((value) => value.toLowerCase());
const registerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: emailSchema,
  password: z.string().min(12).max(72).refine((value) => Buffer.byteLength(value, "utf8") <= 72),
}).strict();
const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(72).refine((value) => Buffer.byteLength(value, "utf8") <= 72),
}).strict();

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(refreshCookieName, token, {
    httpOnly: true,
    secure: config.COOKIE_SECURE || config.isProduction,
    sameSite: "lax",
    path: "/api/v1/auth",
    maxAge: config.refreshTokenTtlMs,
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(refreshCookieName, {
    httpOnly: true,
    secure: config.COOKIE_SECURE || config.isProduction,
    sameSite: "lax",
    path: "/api/v1/auth",
  });
}

async function issueSession(userId: string): Promise<string> {
  const token = randomBytes(48).toString("base64url");
  await prisma.refreshSession.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + config.refreshTokenTtlMs),
    },
  });
  return token;
}

function createAccessToken(user: { id: string; email: string }): string {
  return jwt.sign({ email: user.email }, config.JWT_ACCESS_SECRET, {
    algorithm: "HS256",
    subject: user.id,
    expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
    issuer: "taskmaster-api",
    audience: "taskmaster-client",
  });
}

router.post("/register", validateBody(registerSchema), async (req, res) => {
  const { name, email, password } = req.body as z.infer<typeof registerSchema>;
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) throw conflict("An account with this email already exists", "EMAIL_TAKEN");

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { name, email, passwordHash },
    select: { id: true, name: true, email: true, createdAt: true },
  });
  res.status(201).json({ data: user });
});

router.post("/login", validateBody(loginSchema), async (req, res) => {
  const { email, password } = req.body as z.infer<typeof loginSchema>;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw unauthorized("Email or password is incorrect");
  }

  const refreshToken = await issueSession(user.id);
  setRefreshCookie(res, refreshToken);
  res.json({
    data: {
      accessToken: createAccessToken(user),
      tokenType: "Bearer",
      expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
      user: { id: user.id, name: user.name, email: user.email },
    },
  });
});

router.post("/refresh", async (req, res) => {
  const token = req.cookies?.[refreshCookieName];
  if (typeof token !== "string" || token.length < 32) {
    clearRefreshCookie(res);
    throw unauthorized("Refresh session is missing or invalid");
  }

  const tokenHash = hashToken(token);
  const session = await prisma.refreshSession.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, email: true, name: true } } },
  });
  if (!session || session.revokedAt || session.expiresAt <= new Date()) {
    clearRefreshCookie(res);
    throw unauthorized("Refresh session has expired or been revoked");
  }

  const replacementToken = randomBytes(48).toString("base64url");
  const rotated = await prisma.$transaction(async (transaction) => {
    const result = await transaction.refreshSession.updateMany({
      where: { id: session.id, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { revokedAt: new Date() },
    });
    if (result.count !== 1) return false;
    await transaction.refreshSession.create({
      data: {
        userId: session.userId,
        tokenHash: hashToken(replacementToken),
        expiresAt: new Date(Date.now() + config.refreshTokenTtlMs),
      },
    });
    return true;
  });

  if (!rotated) {
    clearRefreshCookie(res);
    throw unauthorized("Refresh session has already been used");
  }
  setRefreshCookie(res, replacementToken);
  res.json({
    data: {
      accessToken: createAccessToken(session.user),
      tokenType: "Bearer",
      expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
      user: session.user,
    },
  });
});

router.post("/logout", authenticate, async (req, res) => {
  const token = req.cookies?.[refreshCookieName];
  if (typeof token === "string") {
    await prisma.refreshSession.updateMany({
      where: { tokenHash: hashToken(token), userId: req.auth!.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  clearRefreshCookie(res);
  res.status(204).end();
});

export default router;
