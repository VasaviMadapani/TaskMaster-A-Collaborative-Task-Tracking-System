import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { notFound } from "../errors";
import { authenticate } from "../middleware/authenticate";
import { validateBody } from "../middleware/validate";

const router = Router();
const profileSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field must be provided");

router.use(authenticate);

router.get("/me", async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.auth!.userId },
    select: { id: true, name: true, email: true, createdAt: true, updatedAt: true },
  });
  if (!user) throw notFound("User not found");
  res.json({ data: user });
});

router.patch("/me", validateBody(profileSchema), async (req, res) => {
  const body = req.body as z.infer<typeof profileSchema>;
  const data: Prisma.UserUpdateInput = {};
  if (body.name !== undefined) data.name = body.name;
  const user = await prisma.user.update({
    where: { id: req.auth!.userId },
    data,
    select: { id: true, name: true, email: true, createdAt: true, updatedAt: true },
  });
  res.json({ data: user });
});

router.get("/me/projects", async (req, res) => {
  const memberships = await prisma.projectMember.findMany({
    where: { userId: req.auth!.userId },
    orderBy: { project: { updatedAt: "desc" } },
    include: {
      project: {
        select: {
          id: true,
          name: true,
          description: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });
  res.json({
    data: memberships.map(({ project, role, joinedAt }) => ({ ...project, role, joinedAt })),
  });
});

export default router;
