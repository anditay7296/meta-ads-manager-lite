import { db, schema } from "@/lib/db/client";
import { and, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";

const {
  decisionJournal,
  ads,
  adSets,
  campaigns,
  adAccounts,
  posts,
  pages,
  igAccounts,
  automatedRules,
} = schema;

type ActorType = "user" | "agent" | "rule" | "system";

export type JournalAppendInput = {
  orgId: string;
  // If absent, we attempt to derive from entityKind + entityId. May remain null
  // for org-wide system events (cron-ticks, dev setup, cross-account syncs).
  projectId?: string | null;
  actorType: ActorType;
  actorRef: string | null;
  summary: string;
  reasoning?: string | null;
  entityKind: string | null;
  entityId: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
};

// Resolve the project an entity belongs to. Returns null for entity kinds with
// no project (system/cron/agent_action) or when the lookup misses.
async function resolveProjectIdForEntity(
  kind: string | null,
  entityId: string | null,
): Promise<string | null> {
  if (!kind || !entityId) return null;
  // Normalize the inconsistent ad_set/adset spelling used across callers.
  const k = kind === "adset" ? "ad_set" : kind;
  try {
    if (k === "project") return entityId;
    if (k === "ad") {
      const row = await db
        .select({ projectId: adAccounts.projectId })
        .from(ads)
        .innerJoin(adSets, eq(adSets.id, ads.adSetId))
        .innerJoin(campaigns, eq(campaigns.id, adSets.campaignId))
        .innerJoin(adAccounts, eq(adAccounts.id, campaigns.adAccountId))
        .where(eq(ads.id, entityId))
        .limit(1);
      return row[0]?.projectId ?? null;
    }
    if (k === "ad_set") {
      const row = await db
        .select({ projectId: adAccounts.projectId })
        .from(adSets)
        .innerJoin(campaigns, eq(campaigns.id, adSets.campaignId))
        .innerJoin(adAccounts, eq(adAccounts.id, campaigns.adAccountId))
        .where(eq(adSets.id, entityId))
        .limit(1);
      return row[0]?.projectId ?? null;
    }
    if (k === "campaign") {
      const row = await db
        .select({ projectId: adAccounts.projectId })
        .from(campaigns)
        .innerJoin(adAccounts, eq(adAccounts.id, campaigns.adAccountId))
        .where(eq(campaigns.id, entityId))
        .limit(1);
      return row[0]?.projectId ?? null;
    }
    if (k === "post" || k === "story") {
      const row = await db
        .select({
          pageProject: pages.projectId,
          igProject: igAccounts.projectId,
        })
        .from(posts)
        .leftJoin(pages, eq(pages.id, posts.pageId))
        .leftJoin(igAccounts, eq(igAccounts.id, posts.igAccountId))
        .where(eq(posts.id, entityId))
        .limit(1);
      return row[0]?.pageProject ?? row[0]?.igProject ?? null;
    }
    if (k === "rule") {
      const row = await db
        .select({
          ruleProject: automatedRules.appliesToProjectId,
          accountProject: adAccounts.projectId,
        })
        .from(automatedRules)
        .leftJoin(
          adAccounts,
          eq(adAccounts.id, automatedRules.appliesToAdAccountId),
        )
        .where(eq(automatedRules.id, entityId))
        .limit(1);
      return row[0]?.ruleProject ?? row[0]?.accountProject ?? null;
    }
  } catch {
    // A bad entityId (e.g. non-UUID string in legacy rows) shouldn't break the
    // journal write — fall through and store null.
  }
  return null;
}

export async function journalAppend(input: JournalAppendInput): Promise<void> {
  const projectId =
    input.projectId === undefined
      ? await resolveProjectIdForEntity(input.entityKind, input.entityId)
      : input.projectId;
  await db.insert(decisionJournal).values({
    orgId: input.orgId,
    projectId,
    actorType: input.actorType,
    actorRef: input.actorRef,
    summary: input.summary,
    reasoning: input.reasoning ?? null,
    entityKind: input.entityKind,
    entityId: input.entityId,
    before: (input.before as object | null) ?? null,
    after: (input.after as object | null) ?? null,
    metadata: (input.metadata as object | null) ?? null,
  });
}

export type JournalEntry = {
  id: string;
  occurredAt: Date;
  actorType: ActorType;
  actorRef: string | null;
  summary: string;
  reasoning: string | null;
  entityKind: string | null;
  entityId: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
};

export async function listJournal(opts: {
  orgId: string;
  // When set, restricts to entries tied to this project. Entries with a NULL
  // project_id (org-wide system events) are always included so cron-ticks /
  // dev setup still surface in every project view.
  projectId?: string | null;
  limit?: number;
  since?: Date;
  until?: Date;
  actorType?: ActorType;
  entityKind?: string;
  search?: string;
}): Promise<JournalEntry[]> {
  const conditions = [eq(decisionJournal.orgId, opts.orgId)];
  if (opts.projectId) {
    const projectFilter = or(
      eq(decisionJournal.projectId, opts.projectId),
      isNull(decisionJournal.projectId),
    );
    if (projectFilter) conditions.push(projectFilter);
  }
  if (opts.since) conditions.push(gte(decisionJournal.occurredAt, opts.since));
  if (opts.until) conditions.push(lte(decisionJournal.occurredAt, opts.until));
  if (opts.actorType) conditions.push(eq(decisionJournal.actorType, opts.actorType));
  if (opts.entityKind) conditions.push(eq(decisionJournal.entityKind, opts.entityKind));
  if (opts.search) {
    const term = `%${opts.search.toLowerCase()}%`;
    conditions.push(
      sql`(lower(${decisionJournal.summary}) like ${term} or lower(coalesce(${decisionJournal.reasoning},'')) like ${term})`,
    );
  }
  const rows = await db
    .select()
    .from(decisionJournal)
    .where(and(...conditions))
    .orderBy(desc(decisionJournal.occurredAt))
    .limit(opts.limit ?? 100);
  return rows as unknown as JournalEntry[];
}
