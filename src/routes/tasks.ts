import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { Prisma, TaskPriority, TaskStatus } from "@prisma/client";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { config } from "../config";
import { prisma } from "../db";
import { badRequest, forbidden, notFound } from "../errors";
import { requireAssigneeMembership, requireProjectMembership } from "../lib/access";
import { removeStoredAttachments } from "../lib/attachments";
import { logger } from "../logger";
import { authenticate } from "../middleware/authenticate";
import { validateBody, validateParams } from "../middleware/validate";

const router = Router();
const taskParams = z.object({ projectId: z.string().uuid(), taskId: z.string().uuid() });
const projectParams = z.object({ projectId: z.string().uuid() });
const taskQuerySchema = z.object({
  status: z.nativeEnum(TaskStatus).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(200).optional(),
  assigneeId: z.string().uuid().optional(),
  priority: z.nativeEnum(TaskPriority).optional(),
  sortBy: z.enum(["createdAt", "updatedAt", "dueDate", "title"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
});

const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(10000).nullable().optional(),
  dueDate: z.string().datetime({ offset: true }).nullable().optional(),
  priority: z.nativeEnum(TaskPriority).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
}).strict();
const updateTaskSchema = createTaskSchema.extend({
  status: z.nativeEnum(TaskStatus).optional(),
}).partial().refine((value) => Object.keys(value).length > 0, "At least one field must be provided");
const commentSchema = z.object({ body: z.string().trim().min(1).max(5000) }).strict();
const attachmentParams = taskParams.extend({ attachmentId: z.string().uuid() });
const allowedMimeTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
  "text/csv",
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: config.UPLOAD_DIR,
    filename: (_req, _file, callback) => callback(null, randomUUID()),
  }),
  limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1, fields: 0 },
  fileFilter: (_req, file, callback) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      callback(badRequest("Unsupported attachment type", "UNSUPPORTED_FILE_TYPE"));
      return;
    }
    callback(null, true);
  },
});

async function ensureTaskAccess(projectId: string, taskId: string, userId: string) {
  await requireProjectMembership(projectId, userId);
  const task = await prisma.task.findFirst({ where: { id: taskId, projectId } });
  if (!task) throw notFound("Task not found");
  return task;
}

function taskAccessMiddleware(req: import("express").Request, _res: import("express").Response, next: import("express").NextFunction) {
  const parsed = taskParams.safeParse(req.params);
  if (!parsed.success) {
    next(parsed.error);
    return;
  }
  ensureTaskAccess(parsed.data.projectId, parsed.data.taskId, req.auth!.userId).then(
    () => next(),
    (error: unknown) => next(error),
  );
}

router.use(authenticate);

router.post("/:projectId/tasks", validateParams(projectParams), validateBody(createTaskSchema), async (req, res) => {
  const { projectId } = projectParams.parse(req.params);
  await requireProjectMembership(projectId, req.auth!.userId);
  const body = req.body as z.infer<typeof createTaskSchema>;
  await requireAssigneeMembership(projectId, body.assigneeId);
  const task = await prisma.task.create({
    data: {
      projectId,
      title: body.title,
      description: body.description ?? null,
      dueDate: body.dueDate ? new Date(body.dueDate) : null,
      priority: body.priority ?? TaskPriority.MEDIUM,
      assigneeId: body.assigneeId ?? null,
      createdById: req.auth!.userId,
    },
    include: {
      assignee: { select: { id: true, name: true, email: true } },
      createdBy: { select: { id: true, name: true } },
    },
  });
  res.status(201).json({ data: task });
});

router.get("/:projectId/tasks", validateParams(projectParams), async (req, res) => {
  const { projectId } = projectParams.parse(req.params);
  await requireProjectMembership(projectId, req.auth!.userId);
  const query = taskQuerySchema.parse(req.query);
  await requireAssigneeMembership(projectId, query.assigneeId);
  const where: Prisma.TaskWhereInput = {
    projectId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.priority ? { priority: query.priority } : {}),
    ...(query.assigneeId ? { assigneeId: query.assigneeId } : {}),
    ...(query.search
      ? { OR: [{ title: { contains: query.search, mode: "insensitive" } }, { description: { contains: query.search, mode: "insensitive" } }] }
      : {}),
  };
  const [data, total] = await prisma.$transaction([
    prisma.task.findMany({
      where,
      orderBy: { [query.sortBy]: query.order },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      include: {
        assignee: { select: { id: true, name: true, email: true } },
        createdBy: { select: { id: true, name: true } },
      },
    }),
    prisma.task.count({ where }),
  ]);
  res.json({ data, pagination: { page: query.page, limit: query.limit, total } });
});

router.get("/:projectId/tasks/:taskId", validateParams(taskParams), async (req, res) => {
  const { projectId, taskId } = taskParams.parse(req.params);
  await ensureTaskAccess(projectId, taskId, req.auth!.userId);
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      assignee: { select: { id: true, name: true, email: true } },
      createdBy: { select: { id: true, name: true } },
      _count: { select: { comments: true, attachments: true } },
    },
  });
  if (!task) throw notFound("Task not found");
  res.json({ data: task });
});

router.patch("/:projectId/tasks/:taskId", validateParams(taskParams), validateBody(updateTaskSchema), async (req, res) => {
  const { projectId, taskId } = taskParams.parse(req.params);
  await ensureTaskAccess(projectId, taskId, req.auth!.userId);
  const body = req.body as z.infer<typeof updateTaskSchema>;
  if (Object.prototype.hasOwnProperty.call(body, "assigneeId")) {
    await requireAssigneeMembership(projectId, body.assigneeId);
  }
  const { dueDate, ...rest } = body;
  const data: Prisma.TaskUpdateInput = {};
  if (rest.title !== undefined) data.title = rest.title;
  if (rest.description !== undefined) data.description = rest.description;
  if (rest.priority !== undefined) data.priority = rest.priority;
  if (rest.status !== undefined) data.status = rest.status;
  if (rest.assigneeId !== undefined) data.assignee = rest.assigneeId
    ? { connect: { id: rest.assigneeId } }
    : { disconnect: true };
  if (dueDate !== undefined) data.dueDate = dueDate ? new Date(dueDate) : null;
  const task = await prisma.task.update({
    where: { id: taskId },
    data,
    include: { assignee: { select: { id: true, name: true, email: true } } },
  });
  res.json({ data: task });
});

router.delete("/:projectId/tasks/:taskId", validateParams(taskParams), async (req, res) => {
  const { projectId, taskId } = taskParams.parse(req.params);
  const task = await ensureTaskAccess(projectId, taskId, req.auth!.userId);
  const membership = await requireProjectMembership(projectId, req.auth!.userId);
  if (task.createdById !== req.auth!.userId && membership.role !== "OWNER" && membership.role !== "ADMIN") {
    throw forbidden("Only the task creator or a project administrator can delete this task");
  }
  const attachments = await prisma.attachment.findMany({ where: { taskId }, select: { storageKey: true } });
  await prisma.task.delete({ where: { id: taskId } });
  await removeStoredAttachments(attachments.map(({ storageKey }) => storageKey));
  res.status(204).end();
});

router.get("/:projectId/tasks/:taskId/comments", validateParams(taskParams), async (req, res) => {
  const { projectId, taskId } = taskParams.parse(req.params);
  await ensureTaskAccess(projectId, taskId, req.auth!.userId);
  const comments = await prisma.comment.findMany({
    where: { taskId },
    orderBy: { createdAt: "asc" },
    include: { author: { select: { id: true, name: true } } },
  });
  res.json({ data: comments });
});

router.post("/:projectId/tasks/:taskId/comments", validateParams(taskParams), validateBody(commentSchema), async (req, res) => {
  const { projectId, taskId } = taskParams.parse(req.params);
  await ensureTaskAccess(projectId, taskId, req.auth!.userId);
  const { body } = req.body as z.infer<typeof commentSchema>;
  const comment = await prisma.comment.create({
    data: { taskId, authorId: req.auth!.userId, body },
    include: { author: { select: { id: true, name: true } } },
  });
  res.status(201).json({ data: comment });
});

router.get("/:projectId/tasks/:taskId/attachments", validateParams(taskParams), async (req, res) => {
  const { projectId, taskId } = taskParams.parse(req.params);
  await ensureTaskAccess(projectId, taskId, req.auth!.userId);
  const attachments = await prisma.attachment.findMany({
    where: { taskId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      originalName: true,
      mimeType: true,
      sizeBytes: true,
      createdAt: true,
      uploadedById: true,
    },
  });
  res.json({ data: attachments });
});

router.post(
  "/:projectId/tasks/:taskId/attachments",
  validateParams(taskParams),
  taskAccessMiddleware,
  upload.single("file"),
  async (req, res) => {
    const { projectId, taskId } = taskParams.parse(req.params);
    const file = req.file;
    if (!file) throw badRequest("A file field named 'file' is required");
    try {
      const attachment = await prisma.attachment.create({
        data: {
          taskId,
          uploadedById: req.auth!.userId,
          originalName: path.posix
            .basename(file.originalname.replace(/\\/g, "/"))
            .replace(/[\u0000-\u001f\u007f]/g, "")
            .slice(0, 255) || "attachment",
          storageKey: file.filename,
          mimeType: file.mimetype,
          sizeBytes: file.size,
        },
        select: {
          id: true,
          originalName: true,
          mimeType: true,
          sizeBytes: true,
          createdAt: true,
          uploadedById: true,
        },
      });
      res.status(201).json({ data: attachment });
    } catch (error) {
      try {
        await unlink(file.path);
      } catch (cleanupError) {
        logger.error({ err: cleanupError, path: file.path }, "Unable to remove attachment after database failure");
      }
      throw error;
    }
  },
);

router.get("/:projectId/tasks/:taskId/attachments/:attachmentId", validateParams(attachmentParams), async (req, res, next) => {
  const { projectId, taskId, attachmentId } = attachmentParams.parse(req.params);
  await ensureTaskAccess(projectId, taskId, req.auth!.userId);
  const attachment = await prisma.attachment.findFirst({ where: { id: attachmentId, taskId } });
  if (!attachment) throw notFound("Attachment not found");
  const filePath = path.resolve(config.UPLOAD_DIR, attachment.storageKey);
  if (path.dirname(filePath) !== path.resolve(config.UPLOAD_DIR)) {
    throw notFound("Attachment file not found");
  }
  res.download(filePath, attachment.originalName, (error) => {
    if (!error) return;
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    next(error);
  });
});

router.delete("/:projectId/tasks/:taskId/attachments/:attachmentId", validateParams(attachmentParams), async (req, res) => {
  const { projectId, taskId, attachmentId } = attachmentParams.parse(req.params);
  const task = await ensureTaskAccess(projectId, taskId, req.auth!.userId);
  const attachment = await prisma.attachment.findFirst({ where: { id: attachmentId, taskId } });
  if (!attachment) throw notFound("Attachment not found");
  const membership = await requireProjectMembership(projectId, req.auth!.userId);
  if (
    attachment.uploadedById !== req.auth!.userId &&
    task.createdById !== req.auth!.userId &&
    membership.role !== "OWNER" &&
    membership.role !== "ADMIN"
  ) {
    throw forbidden("Only the uploader, task creator, or a project administrator can delete this attachment");
  }
  await prisma.attachment.delete({ where: { id: attachmentId } });
  await removeStoredAttachments([attachment.storageKey]);
  res.status(204).end();
});

export default router;
