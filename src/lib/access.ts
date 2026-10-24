import { ProjectRole } from "@prisma/client";
import { prisma } from "../db";
import { forbidden, notFound } from "../errors";

export async function requireProjectMembership(projectId: string, userId: string) {
  const membership = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    include: { project: { select: { id: true, name: true } } },
  });
  if (!membership) throw notFound("Project not found");
  return membership;
}

export async function requireProjectManager(projectId: string, userId: string) {
  const membership = await requireProjectMembership(projectId, userId);
  if (membership.role !== ProjectRole.OWNER && membership.role !== ProjectRole.ADMIN) {
    throw forbidden("Project owner or administrator role required");
  }
  return membership;
}

export async function requireAssigneeMembership(projectId: string, userId: string | null | undefined) {
  if (!userId) return;
  const membership = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { userId: true },
  });
  if (!membership) throw forbidden("Assignee must be a member of the project");
}
