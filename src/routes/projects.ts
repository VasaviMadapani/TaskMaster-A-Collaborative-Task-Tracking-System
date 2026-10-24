import { createHash, randomBytes } from "node:crypto";
import { Prisma, ProjectRole } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/authenticate";
import { validateBody, validateParams } from "../middleware/validate";
import { prisma } from "../db";
import { conflict, forbidden, notFound } from "../errors";
import { requireProjectManager, requireProjectMembership } from "../lib/access";
import { removeStoredAttachments } from "../lib/attachments";

const router = Router();
const projectParams = z.object({ projectId: z.string().uuid() });
const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).nullable().optional(),
}).strict();
const updateProjectSchema = createProjectSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field must be provided",
);
const inviteSchema = z.object({
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
}).strict();
const memberRoleSchema = z.object({
  role: z.enum([ProjectRole.ADMIN, ProjectRole.MEMBER]),
}).strict();
const acceptInviteSchema = z.object({ token: z.string().min(32).max(200) }).strict();
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

router.use(authenticate);

router.post("/", validateBody(createProjectSchema), async (req, res) => {
  const body = req.body as z.infer<typeof createProjectSchema>;
  const project = await prisma.project.create({
    data: {
      name: body.name,
      description: body.description ?? null,
      createdById: req.auth!.userId,
      members: { create: { userId: req.auth!.userId, role: ProjectRole.OWNER } },
    },
    include: { members: { select: { userId: true, role: true, joinedAt: true } } },
  });
  res.status(201).json({ data: project });
});

router.post("/invites/accept", validateBody(acceptInviteSchema), async (req, res) => {
  const { token } = req.body as z.infer<typeof acceptInviteSchema>;
  const invite = await prisma.projectInvite.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { project: { select: { id: true, name: true } } },
  });
  if (!invite || invite.acceptedAt || invite.expiresAt <= new Date()) {
    throw conflict("Invitation is invalid, expired, or already accepted", "INVITE_INVALID");
  }
  if (invite.email !== req.auth!.email.toLowerCase()) {
    throw forbidden("This invitation was sent to a different email address");
  }

  const accepted = await prisma.$transaction(async (transaction) => {
    const updated = await transaction.projectInvite.updateMany({
      where: { id: invite.id, acceptedAt: null, expiresAt: { gt: new Date() } },
      data: { acceptedAt: new Date() },
    });
    if (updated.count !== 1) return false;
    await transaction.projectMember.upsert({
      where: { projectId_userId: { projectId: invite.projectId, userId: req.auth!.userId } },
      create: { projectId: invite.projectId, userId: req.auth!.userId, role: invite.role },
      update: {},
    });
    return true;
  });
  if (!accepted) throw conflict("Invitation has already been accepted", "INVITE_INVALID");
  res.json({ data: { project: invite.project } });
});

router.get("/:projectId", validateParams(projectParams), async (req, res) => {
  const { projectId } = projectParams.parse(req.params);
  await requireProjectMembership(projectId, req.auth!.userId);
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      members: {
        orderBy: { joinedAt: "asc" },
        select: {
          role: true,
          joinedAt: true,
          user: { select: { id: true, name: true, email: true } },
        },
      },
    },
  });
  if (!project) throw notFound("Project not found");
  res.json({ data: project });
});

router.patch("/:projectId", validateParams(projectParams), validateBody(updateProjectSchema), async (req, res) => {
  const { projectId } = projectParams.parse(req.params);
  await requireProjectManager(projectId, req.auth!.userId);
  const body = req.body as z.infer<typeof updateProjectSchema>;
  const data: Prisma.ProjectUpdateInput = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.description !== undefined) data.description = body.description;
  const project = await prisma.project.update({
    where: { id: projectId },
    data,
  });
  res.json({ data: project });
});

router.delete("/:projectId", validateParams(projectParams), async (req, res) => {
  const { projectId } = projectParams.parse(req.params);
  const membership = await requireProjectMembership(projectId, req.auth!.userId);
  if (membership.role !== ProjectRole.OWNER) throw forbidden("Only the project owner can delete the project");
  const attachments = await prisma.attachment.findMany({
    where: { task: { projectId } },
    select: { storageKey: true },
  });
  await prisma.project.delete({ where: { id: projectId } });
  await removeStoredAttachments(attachments.map(({ storageKey }) => storageKey));
  res.status(204).end();
});

router.get("/:projectId/members", validateParams(projectParams), async (req, res) => {
  const { projectId } = projectParams.parse(req.params);
  await requireProjectMembership(projectId, req.auth!.userId);
  const members = await prisma.projectMember.findMany({
    where: { projectId },
    orderBy: { joinedAt: "asc" },
    select: {
      role: true,
      joinedAt: true,
      user: { select: { id: true, name: true, email: true } },
    },
  });
  res.json({ data: members });
});

router.patch(
  "/:projectId/members/:memberId",
  validateParams(projectParams.extend({ memberId: z.string().uuid() })),
  validateBody(memberRoleSchema),
  async (req, res) => {
    const { projectId, memberId } = projectParams.extend({ memberId: z.string().uuid() }).parse(req.params);
    const actor = await requireProjectMembership(projectId, req.auth!.userId);
    if (actor.role !== ProjectRole.OWNER) throw forbidden("Only the project owner can change member roles");
    const target = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: memberId } },
      select: { role: true },
    });
    if (!target) throw notFound("Project member not found");
    if (target.role === ProjectRole.OWNER) throw forbidden("The project owner role cannot be changed");
    const { role } = req.body as z.infer<typeof memberRoleSchema>;
    const member = await prisma.projectMember.update({
      where: { projectId_userId: { projectId, userId: memberId } },
      data: { role },
      select: {
        role: true,
        joinedAt: true,
        user: { select: { id: true, name: true, email: true } },
      },
    });
    res.json({ data: member });
  },
);

router.post("/:projectId/invites", validateParams(projectParams), validateBody(inviteSchema), async (req, res) => {
  const { projectId } = projectParams.parse(req.params);
  await requireProjectManager(projectId, req.auth!.userId);
  const { email } = req.body as z.infer<typeof inviteSchema>;
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (user) {
    const existingMembership = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: user.id } },
    });
    if (existingMembership) throw conflict("This user is already a project member", "ALREADY_MEMBER");
  }

  const token = randomBytes(32).toString("base64url");
  const invite = await prisma.projectInvite.create({
    data: {
      projectId,
      email,
      role: ProjectRole.MEMBER,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
    select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
  });
  res.status(201).json({
    data: {
      ...invite,
      inviteToken: token,
      deliveryNote: "Deliver inviteToken to the invitee over a trusted channel.",
    },
  });
});

router.delete("/:projectId/members/:memberId", validateParams(
  projectParams.extend({ memberId: z.string().uuid() }),
), async (req, res) => {
  const { projectId, memberId } = projectParams.extend({ memberId: z.string().uuid() }).parse(req.params);
  const actor = await requireProjectManager(projectId, req.auth!.userId);
  const target = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: memberId } },
    select: { role: true },
  });
  if (!target) throw notFound("Project member not found");
  if (target.role === ProjectRole.OWNER) throw forbidden("The project owner cannot be removed");
  if (target.role === ProjectRole.ADMIN && actor.role !== ProjectRole.OWNER) {
    throw forbidden("Only the owner can remove another administrator");
  }
  await prisma.projectMember.delete({ where: { projectId_userId: { projectId, userId: memberId } } });
  res.status(204).end();
});

export default router;
