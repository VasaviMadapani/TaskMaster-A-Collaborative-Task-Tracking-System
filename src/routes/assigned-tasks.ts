import { Prisma, TaskStatus } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { authenticate } from "../middleware/authenticate";

const router = Router();
const querySchema = z.object({
  status: z.nativeEnum(TaskStatus).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(200).optional(),
});

router.use(authenticate);

router.get("/assigned", async (req, res) => {
  const query = querySchema.parse(req.query);
  const where: Prisma.TaskWhereInput = {
    assigneeId: req.auth!.userId,
    project: { members: { some: { userId: req.auth!.userId } } },
    ...(query.status ? { status: query.status } : {}),
    ...(query.search
      ? {
          OR: [
            { title: { contains: query.search, mode: "insensitive" } },
            { description: { contains: query.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [data, total] = await prisma.$transaction([
    prisma.task.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      include: {
        project: { select: { id: true, name: true } },
        assignee: { select: { id: true, name: true, email: true } },
        createdBy: { select: { id: true, name: true } },
      },
    }),
    prisma.task.count({ where }),
  ]);
  res.json({ data, pagination: { page: query.page, limit: query.limit, total } });
});

export default router;
