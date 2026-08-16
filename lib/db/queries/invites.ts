import { db, schema } from "@/lib/db/client";
import { and, eq, gt } from "drizzle-orm";
import { randomUUID } from "crypto";

const { invites, orgMembers, projectMembers, users } = schema;

export type InviteRow = typeof invites.$inferSelect;

export type PendingInvite = {
  id: string;
  email: string;
  role: "owner" | "admin" | "member";
  projectId: string | null;
  projectName: string | null;
  expiresAt: Date;
  createdAt: Date;
};

export type OrgMemberRow = {
  userId: string;
  email: string | null;
  fullName: string | null;
  role: "owner" | "admin" | "member";
};

export async function listOrgMembers(orgId: string): Promise<OrgMemberRow[]> {
  return db
    .select({
      userId: orgMembers.userId,
      email: users.email,
      fullName: users.fullName,
      role: orgMembers.role,
    })
    .from(orgMembers)
    .leftJoin(users, eq(users.id, orgMembers.userId))
    .where(eq(orgMembers.orgId, orgId));
}

export type ProjectMemberRow = {
  userId: string;
  projectId: string;
  projectName: string;
  role: "admin" | "member";
};

/**
 * Returns every project_members row in the org joined to the project's name.
 * Used by TeamPanel to show "X has access to projects A, B, C" alongside
 * the org-level role.
 */
export async function listProjectMembersForOrg(
  orgId: string,
): Promise<ProjectMemberRow[]> {
  return db
    .select({
      userId: projectMembers.userId,
      projectId: projectMembers.projectId,
      projectName: schema.projects.name,
      role: projectMembers.role,
    })
    .from(projectMembers)
    .innerJoin(schema.projects, eq(schema.projects.id, projectMembers.projectId))
    .where(eq(schema.projects.orgId, orgId));
}

export async function listPendingInvites(orgId: string): Promise<PendingInvite[]> {
  return db
    .select({
      id: invites.id,
      email: invites.email,
      role: invites.role,
      projectId: invites.projectId,
      projectName: schema.projects.name,
      expiresAt: invites.expiresAt,
      createdAt: invites.createdAt,
    })
    .from(invites)
    .leftJoin(schema.projects, eq(schema.projects.id, invites.projectId))
    .where(
      and(
        eq(invites.orgId, orgId),
        eq(invites.status, "pending"),
        gt(invites.expiresAt, new Date()),
      ),
    );
}

export async function createInvite(opts: {
  orgId: string;
  email: string;
  role: "admin" | "member";
  invitedBy: string;
  /**
   * Optional. When set, accepting the invite also creates a project_members
   * row scoping the invitee to this project. Only meaningful for role=member;
   * admins see all projects regardless.
   */
  projectId?: string;
}): Promise<InviteRow> {
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  const [row] = await db
    .insert(invites)
    .values({
      orgId: opts.orgId,
      email: opts.email.toLowerCase().trim(),
      role: opts.role,
      projectId: opts.projectId ?? null,
      token,
      status: "pending",
      invitedBy: opts.invitedBy,
      expiresAt,
    })
    .returning();
  return row;
}

export async function revokeInvite(opts: {
  orgId: string;
  inviteId: string;
}): Promise<void> {
  await db
    .update(invites)
    .set({ status: "revoked" })
    .where(
      and(eq(invites.orgId, opts.orgId), eq(invites.id, opts.inviteId)),
    );
}

export async function findPendingInviteByToken(
  token: string,
): Promise<(InviteRow & { orgName: string | null }) | null> {
  const [row] = await db
    .select({
      id: invites.id,
      orgId: invites.orgId,
      email: invites.email,
      role: invites.role,
      token: invites.token,
      status: invites.status,
      invitedBy: invites.invitedBy,
      expiresAt: invites.expiresAt,
      acceptedAt: invites.acceptedAt,
      createdAt: invites.createdAt,
      orgName: schema.orgs.name,
    })
    .from(invites)
    .leftJoin(schema.orgs, eq(schema.orgs.id, invites.orgId))
    .where(
      and(
        eq(invites.token, token),
        eq(invites.status, "pending"),
        gt(invites.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return (row as (InviteRow & { orgName: string | null }) | undefined) ?? null;
}

export async function acceptInvite(opts: {
  token: string;
  authUserId: string;
  email: string;
}): Promise<{ orgId: string; projectId: string | null } | null> {
  // Re-fetch inside to be safe
  const [invite] = await db
    .select()
    .from(invites)
    .where(
      and(
        eq(invites.token, opts.token),
        eq(invites.status, "pending"),
        gt(invites.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!invite) return null;

  // Email must match (case-insensitive)
  if (invite.email.toLowerCase() !== opts.email.toLowerCase()) return null;

  return db.transaction(async (tx) => {
    // Upsert users row
    await tx
      .insert(users)
      .values({ id: opts.authUserId, email: opts.email })
      .onConflictDoNothing();

    // Add to org (skip if already a member)
    await tx
      .insert(orgMembers)
      .values({
        orgId: invite.orgId,
        userId: opts.authUserId,
        role: invite.role,
      })
      .onConflictDoNothing();

    // Add to the scoped project if the invite was project-scoped. Admin
    // invites typically don't carry a project (admins see everything) but
    // if one is set we still grant project_members so the join in
    // listProjectsForUser succeeds for both code paths.
    if (invite.projectId) {
      await tx
        .insert(projectMembers)
        .values({
          projectId: invite.projectId,
          userId: opts.authUserId,
          role: invite.role === "admin" ? "admin" : "member",
        })
        .onConflictDoNothing();
    }

    // Mark accepted
    await tx
      .update(invites)
      .set({ status: "accepted", acceptedAt: new Date() })
      .where(eq(invites.id, invite.id));

    return { orgId: invite.orgId, projectId: invite.projectId };
  });
}
