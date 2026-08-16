import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";

/**
 * Defence-in-depth: throws if the given user cannot access the given project.
 *
 * An action is "accessible" if the user is one of:
 *   - org owner / admin (sees all projects in the org)
 *   - listed in project_members for this project
 *
 * Call this at the top of any server action that mutates project-scoped data
 * — especially agent approval handlers, where the agent's tool input could
 * theoretically reference a resource (page, ad account, ad) that belongs to
 * a project the approving user shouldn't see.
 *
 * Throws on denial so the action returns a server error rather than silently
 * executing.
 */
export async function assertProjectAccess(opts: {
  userId: string;
  projectId: string;
}): Promise<void> {
  const [proj] = await db
    .select({ id: schema.projects.id, orgId: schema.projects.orgId })
    .from(schema.projects)
    .where(eq(schema.projects.id, opts.projectId))
    .limit(1);
  if (!proj) {
    throw new Error("Project not found");
  }

  // Org-level priv (owner/admin) wins.
  const [orgRow] = await db
    .select({ role: schema.orgMembers.role })
    .from(schema.orgMembers)
    .where(
      and(
        eq(schema.orgMembers.orgId, proj.orgId),
        eq(schema.orgMembers.userId, opts.userId),
      ),
    )
    .limit(1);
  if (!orgRow) {
    throw new Error("User is not a member of this workspace");
  }
  if (orgRow.role === "owner" || orgRow.role === "admin") return;

  // Otherwise require a project_members row.
  const [projMember] = await db
    .select({ id: schema.projectMembers.id })
    .from(schema.projectMembers)
    .where(
      and(
        eq(schema.projectMembers.projectId, opts.projectId),
        eq(schema.projectMembers.userId, opts.userId),
      ),
    )
    .limit(1);
  if (!projMember) {
    throw new Error("User does not have access to this project");
  }
}

/**
 * Resolves an ad account ID to its parent project ID, then asserts access.
 * Useful for write actions that target ads/adsets/campaigns: walk the FK
 * chain up to the project and gate on project membership.
 */
export async function assertAdAccountAccess(opts: {
  userId: string;
  adAccountId: string;
}): Promise<void> {
  const [row] = await db
    .select({ projectId: schema.adAccounts.projectId })
    .from(schema.adAccounts)
    .where(eq(schema.adAccounts.id, opts.adAccountId))
    .limit(1);
  if (!row || !row.projectId) {
    throw new Error("Ad account not found or not linked to a project");
  }
  await assertProjectAccess({ userId: opts.userId, projectId: row.projectId });
}

/**
 * Resolves a page ID to its parent project ID, then asserts access.
 */
export async function assertPageAccess(opts: {
  userId: string;
  pageId: string;
}): Promise<void> {
  const [row] = await db
    .select({ projectId: schema.pages.projectId })
    .from(schema.pages)
    .where(eq(schema.pages.id, opts.pageId))
    .limit(1);
  if (!row || !row.projectId) {
    throw new Error("Page not found or not linked to a project");
  }
  await assertProjectAccess({ userId: opts.userId, projectId: row.projectId });
}
