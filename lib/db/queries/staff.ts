import { db, schema } from "@/lib/db/client";
import { and, eq, inArray } from "drizzle-orm";
import type { AppSession } from "@/lib/auth/session";

const { users, orgMembers, projectMembers, projects } = schema;

/**
 * Throws if the session's user is not the owner of their org. Used by every
 * staff-management server action; admins/members cannot create or remove
 * other accounts.
 */
export async function requireOrgOwner(session: AppSession): Promise<void> {
  const [row] = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(
      and(
        eq(orgMembers.orgId, session.orgId),
        eq(orgMembers.userId, session.userId),
      ),
    )
    .limit(1);
  if (!row || row.role !== "owner") {
    throw new Error("Only the workspace owner can manage staff accounts.");
  }
}

/**
 * Insert a freshly-created Supabase auth user into our local users +
 * org_members tables, with optional project_members rows. Idempotent on
 * users.id (no-op if the user already exists) so this is safe to retry
 * after a partial failure.
 */
export async function addStaffMember(opts: {
  orgId: string;
  /** UUID for the new users row. Caller generates with crypto.randomUUID(). */
  authUserId: string;
  email: string;
  passwordHash: string;
  role: "owner" | "admin" | "member";
  fullName?: string | null;
  projectIds?: string[];
}): Promise<void> {
  // Verify any provided projects actually belong to this org — defence in
  // depth against form tampering.
  if (opts.projectIds?.length) {
    const matched = await db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.orgId, opts.orgId),
          inArray(projects.id, opts.projectIds),
        ),
      );
    if (matched.length !== opts.projectIds.length) {
      throw new Error("One or more projects do not belong to this workspace.");
    }
  }

  await db.transaction(async (tx) => {
    // Users row mirrors auth.users; skip if it already exists.
    const existingUser = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, opts.authUserId))
      .limit(1);
    if (existingUser.length === 0) {
      await tx.insert(users).values({
        id: opts.authUserId,
        email: opts.email,
        fullName: opts.fullName ?? null,
        passwordHash: opts.passwordHash,
      });
    } else {
      // User already exists (e.g. owner setting a password for the first
      // time on their pre-existing row). Update the hash in place.
      await tx
        .update(users)
        .set({ passwordHash: opts.passwordHash })
        .where(eq(users.id, opts.authUserId));
    }

    // Org membership — skip if already a member of this org.
    const existingMember = await tx
      .select({ userId: orgMembers.userId })
      .from(orgMembers)
      .where(
        and(
          eq(orgMembers.orgId, opts.orgId),
          eq(orgMembers.userId, opts.authUserId),
        ),
      )
      .limit(1);
    if (existingMember.length === 0) {
      await tx.insert(orgMembers).values({
        orgId: opts.orgId,
        userId: opts.authUserId,
        role: opts.role,
      });
    }

    // Project-level access for members. Admins/owners see every project in
    // the org without explicit project_members rows.
    if (opts.role === "member" && opts.projectIds?.length) {
      for (const projectId of opts.projectIds) {
        const existingProjectMember = await tx
          .select({ userId: projectMembers.userId })
          .from(projectMembers)
          .where(
            and(
              eq(projectMembers.projectId, projectId),
              eq(projectMembers.userId, opts.authUserId),
            ),
          )
          .limit(1);
        if (existingProjectMember.length === 0) {
          await tx.insert(projectMembers).values({
            projectId,
            userId: opts.authUserId,
            role: "member",
          });
        }
      }
    }
  });
}

/**
 * Remove a staff user from this org: deletes their org_members row, all
 * project_members rows in this org, and (if the user belongs to no other
 * org) the local users row. The Supabase auth.users deletion is handled by
 * the caller via the admin SDK — we don't touch that from Drizzle.
 */
export async function removeStaffMember(opts: {
  orgId: string;
  userId: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    // Drop all project_members rows in this org for this user.
    const orgProjectIds = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.orgId, opts.orgId));
    if (orgProjectIds.length > 0) {
      await tx
        .delete(projectMembers)
        .where(
          and(
            eq(projectMembers.userId, opts.userId),
            inArray(
              projectMembers.projectId,
              orgProjectIds.map((p) => p.id),
            ),
          ),
        );
    }

    // Drop the org membership.
    await tx
      .delete(orgMembers)
      .where(
        and(
          eq(orgMembers.orgId, opts.orgId),
          eq(orgMembers.userId, opts.userId),
        ),
      );

    // If this was their only org, drop the users row too.
    const otherMemberships = await tx
      .select({ orgId: orgMembers.orgId })
      .from(orgMembers)
      .where(eq(orgMembers.userId, opts.userId))
      .limit(1);
    if (otherMemberships.length === 0) {
      await tx.delete(users).where(eq(users.id, opts.userId));
    }
  });
}
