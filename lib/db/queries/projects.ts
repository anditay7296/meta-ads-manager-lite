import { db, schema } from "@/lib/db/client";
import { and, eq, inArray, sql } from "drizzle-orm";

const { projects, projectMembers, adAccounts, pages, igAccounts, orgMembers } = schema;

export type ProjectListItem = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  adNamingCode: string | null;
  defaultCallToActionType: string | null;
  defaultLinkUrl: string | null;
  adAccountCount: number;
  pageCount: number;
  memberCount: number;
};

/**
 * List projects visible to a user within an org.
 *
 * - Org owners and admins see every project.
 * - Org members see only projects where they're a `project_members` row.
 */
export async function listProjectsForUser(
  orgId: string,
  userId: string,
): Promise<ProjectListItem[]> {
  const membership = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .limit(1);
  const isOrgPriv =
    membership[0]?.role === "owner" || membership[0]?.role === "admin";

  const baseRows = isOrgPriv
    ? await db
        .select({
          id: projects.id,
          name: projects.name,
          slug: projects.slug,
          description: projects.description,
          adNamingCode: projects.adNamingCode,
          defaultCallToActionType: projects.defaultCallToActionType,
          defaultLinkUrl: projects.defaultLinkUrl,
        })
        .from(projects)
        .where(
          and(
            eq(projects.orgId, orgId),
            sql`${projects.archivedAt} is null`,
          ),
        )
    : await db
        .select({
          id: projects.id,
          name: projects.name,
          slug: projects.slug,
          description: projects.description,
          adNamingCode: projects.adNamingCode,
          defaultCallToActionType: projects.defaultCallToActionType,
          defaultLinkUrl: projects.defaultLinkUrl,
        })
        .from(projects)
        .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
        .where(
          and(
            eq(projects.orgId, orgId),
            eq(projectMembers.userId, userId),
            sql`${projects.archivedAt} is null`,
          ),
        );

  if (baseRows.length === 0) return [];

  const projectIds = baseRows.map((p) => p.id);
  const accountCounts = await db
    .select({
      projectId: adAccounts.projectId,
      count: sql<number>`count(*)::int`,
    })
    .from(adAccounts)
    .where(inArray(adAccounts.projectId, projectIds))
    .groupBy(adAccounts.projectId);
  const pageCounts = await db
    .select({
      projectId: pages.projectId,
      count: sql<number>`count(*)::int`,
    })
    .from(pages)
    .where(inArray(pages.projectId, projectIds))
    .groupBy(pages.projectId);
  const memberCounts = await db
    .select({
      projectId: projectMembers.projectId,
      count: sql<number>`count(*)::int`,
    })
    .from(projectMembers)
    .where(inArray(projectMembers.projectId, projectIds))
    .groupBy(projectMembers.projectId);

  const acctMap = new Map(accountCounts.map((r) => [r.projectId, r.count]));
  const pageMap = new Map(pageCounts.map((r) => [r.projectId, r.count]));
  const memberMap = new Map(memberCounts.map((r) => [r.projectId, r.count]));

  return baseRows.map((p) => ({
    ...p,
    adAccountCount: acctMap.get(p.id) ?? 0,
    pageCount: pageMap.get(p.id) ?? 0,
    memberCount: memberMap.get(p.id) ?? 0,
  }));
}

export async function createProject(opts: {
  orgId: string;
  name: string;
  description?: string;
  createdBy: string;
}): Promise<{ id: string; slug: string }> {
  const slug = await reserveProjectSlug(opts.orgId, slugify(opts.name));
  const [row] = await db
    .insert(projects)
    .values({
      orgId: opts.orgId,
      name: opts.name.trim(),
      description: opts.description?.trim() || null,
      slug,
      createdBy: opts.createdBy,
    })
    .returning({ id: projects.id, slug: projects.slug });
  return row;
}

export async function assignAdAccountToProject(opts: {
  orgId: string;
  adAccountId: string;
  projectId: string | null;
}): Promise<void> {
  await db
    .update(adAccounts)
    .set({ projectId: opts.projectId, updatedAt: sql`now()` })
    .where(
      and(eq(adAccounts.orgId, opts.orgId), eq(adAccounts.id, opts.adAccountId)),
    );
}

export async function assignPageToProject(opts: {
  orgId: string;
  pageId: string;
  projectId: string | null;
}): Promise<void> {
  await db
    .update(pages)
    .set({ projectId: opts.projectId, updatedAt: sql`now()` })
    .where(and(eq(pages.orgId, opts.orgId), eq(pages.id, opts.pageId)));
  // Cascade IG account assignment to follow its parent page.
  await db
    .update(igAccounts)
    .set({ projectId: opts.projectId, updatedAt: sql`now()` })
    .where(
      and(eq(igAccounts.orgId, opts.orgId), eq(igAccounts.pageId, opts.pageId)),
    );
}

/**
 * Idempotent: bulk-assign a list of meta_account_ids (act_xxx) to a project.
 * Returns rows that were actually updated; callers can diff against the
 * requested list to surface IDs that aren't in the org's connected Meta
 * inventory yet.
 */
export async function assignAdAccountsByMetaIds(opts: {
  orgId: string;
  metaAccountIds: string[];
  projectId: string;
}): Promise<Array<{ id: string; metaAccountId: string }>> {
  if (opts.metaAccountIds.length === 0) return [];
  return db
    .update(adAccounts)
    .set({ projectId: opts.projectId, updatedAt: sql`now()` })
    .where(
      and(
        eq(adAccounts.orgId, opts.orgId),
        inArray(adAccounts.metaAccountId, opts.metaAccountIds),
      ),
    )
    .returning({ id: adAccounts.id, metaAccountId: adAccounts.metaAccountId });
}

export async function getProjectByIdForUser(opts: {
  orgId: string;
  userId: string;
  projectId: string;
}): Promise<{ id: string; name: string; slug: string } | null> {
  const list = await listProjectsForUser(opts.orgId, opts.userId);
  const hit = list.find((p) => p.id === opts.projectId);
  return hit ? { id: hit.id, name: hit.name, slug: hit.slug } : null;
}

export async function setProjectAdNamingCode(opts: {
  orgId: string;
  projectId: string;
  code: string | null;
}): Promise<void> {
  const trimmed = opts.code?.trim();
  const value = trimmed && trimmed.length > 0 ? trimmed : null;
  await db
    .update(projects)
    .set({ adNamingCode: value, updatedAt: sql`now()` })
    .where(
      and(eq(projects.orgId, opts.orgId), eq(projects.id, opts.projectId)),
    );
}

/**
 * Set (or clear) a project's boost-flow CTA preset. Pass both `ctaType` and
 * `linkUrl` to enable; pass both null to clear. Callers (the settings action)
 * enforce the both-set-or-both-null invariant before reaching here.
 */
export async function setProjectCtaPreset(opts: {
  orgId: string;
  projectId: string;
  ctaType: string | null;
  linkUrl: string | null;
}): Promise<void> {
  await db
    .update(projects)
    .set({
      defaultCallToActionType: opts.ctaType,
      defaultLinkUrl: opts.linkUrl,
      updatedAt: sql`now()`,
    })
    .where(
      and(eq(projects.orgId, opts.orgId), eq(projects.id, opts.projectId)),
    );
}

export async function setProjectArchived(opts: {
  orgId: string;
  projectId: string;
  archived: boolean;
}): Promise<void> {
  await db
    .update(projects)
    .set({
      archivedAt: opts.archived ? sql`now()` : null,
      updatedAt: sql`now()`,
    })
    .where(
      and(eq(projects.orgId, opts.orgId), eq(projects.id, opts.projectId)),
    );
}

export async function listArchivedProjects(opts: {
  orgId: string;
}): Promise<Array<{ id: string; name: string; slug: string; archivedAt: Date | null }>> {
  return db
    .select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      archivedAt: projects.archivedAt,
    })
    .from(projects)
    .where(
      and(
        eq(projects.orgId, opts.orgId),
        sql`${projects.archivedAt} is not null`,
      ),
    );
}

// ─── Internals ─────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      // Keep CJK and other unicode word chars; replace everything else with -
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

async function reserveProjectSlug(orgId: string, base: string): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const candidate = i === 0 ? base : `${base}-${rand()}`;
    const hit = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.orgId, orgId), eq(projects.slug, candidate)))
      .limit(1);
    if (hit.length === 0) return candidate;
  }
  return `${base}-${rand()}-${rand()}`;
}

function rand(): string {
  return Math.random().toString(36).slice(2, 6);
}
