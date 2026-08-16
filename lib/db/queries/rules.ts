import { db, schema } from "@/lib/db/client";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { RuleConditions, RuleAction, RuleTrigger } from "@/lib/rules/types";

const { automatedRules, ruleExecutions } = schema;

export type RuleRow = typeof automatedRules.$inferSelect;

export type CreateRuleInput = {
  orgId: string;
  name: string;
  description?: string | null;
  scope: "ad" | "adset" | "campaign" | "account";
  conditions: RuleConditions;
  action: RuleAction;
  actionParams?: Record<string, unknown> | null;
  trigger: RuleTrigger;
  schedule?: string | null;
  intervalMinutes?: number | null;
  appliesToProjectId?: string | null;
  appliesToAdAccountId?: string | null;
  syncToMeta?: boolean;
  createdBy: string;
};

export async function createRule(input: CreateRuleInput): Promise<RuleRow> {
  const [row] = await db
    .insert(automatedRules)
    .values({
      orgId: input.orgId,
      name: input.name,
      description: input.description ?? null,
      scope: input.scope,
      conditions: input.conditions as unknown,
      action: input.action,
      actionParams: (input.actionParams as object | null) ?? null,
      trigger: input.trigger,
      schedule: input.schedule ?? null,
      intervalMinutes: input.intervalMinutes ?? null,
      appliesToProjectId: input.appliesToProjectId ?? null,
      appliesToAdAccountId: input.appliesToAdAccountId ?? null,
      syncToMeta: input.syncToMeta ?? false,
      createdBy: input.createdBy,
    })
    .returning();
  return row;
}

export async function listRules(orgId: string): Promise<RuleRow[]> {
  return db
    .select()
    .from(automatedRules)
    .where(eq(automatedRules.orgId, orgId))
    .orderBy(desc(automatedRules.createdAt));
}

export async function listRulesForProject(opts: {
  orgId: string;
  projectId: string;
}): Promise<RuleRow[]> {
  return db
    .select()
    .from(automatedRules)
    .where(
      and(
        eq(automatedRules.orgId, opts.orgId),
        or(
          eq(automatedRules.appliesToProjectId, opts.projectId),
          isNull(automatedRules.appliesToProjectId),
        ),
      ),
    )
    .orderBy(desc(automatedRules.createdAt));
}

export async function deleteRule(opts: {
  orgId: string;
  ruleId: string;
}): Promise<void> {
  await db
    .delete(automatedRules)
    .where(
      and(
        eq(automatedRules.orgId, opts.orgId),
        eq(automatedRules.id, opts.ruleId),
      ),
    );
}

export async function setRuleEnabled(opts: {
  orgId: string;
  ruleId: string;
  enabled: boolean;
}): Promise<void> {
  await db
    .update(automatedRules)
    .set({ enabled: opts.enabled, updatedAt: sql`now()` })
    .where(
      and(
        eq(automatedRules.orgId, opts.orgId),
        eq(automatedRules.id, opts.ruleId),
      ),
    );
}

export async function recordRuleRan(opts: {
  ruleId: string;
}): Promise<void> {
  await db
    .update(automatedRules)
    .set({ lastRanAt: sql`now()` })
    .where(eq(automatedRules.id, opts.ruleId));
}

export type ExecutionInsert = {
  orgId: string;
  ruleId: string;
  matched: number;
  actionsTaken: number;
  dryRun: boolean;
  summary: unknown;
  error?: string | null;
};

export async function logRuleExecution(
  e: ExecutionInsert,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(ruleExecutions)
    .values({
      orgId: e.orgId,
      ruleId: e.ruleId,
      matched: e.matched,
      actionsTaken: e.actionsTaken,
      dryRun: e.dryRun,
      summary: (e.summary as object | null) ?? null,
      error: e.error ?? null,
    })
    .returning({ id: ruleExecutions.id });
  return row;
}

export async function listRecentExecutionsForRule(opts: {
  orgId: string;
  ruleId: string;
  limit?: number;
}) {
  return db
    .select()
    .from(ruleExecutions)
    .where(
      and(
        eq(ruleExecutions.orgId, opts.orgId),
        eq(ruleExecutions.ruleId, opts.ruleId),
      ),
    )
    .orderBy(desc(ruleExecutions.ranAt))
    .limit(opts.limit ?? 10);
}

export async function listRecentExecutionsForOrg(opts: {
  orgId: string;
  limit?: number;
}) {
  return db
    .select()
    .from(ruleExecutions)
    .where(eq(ruleExecutions.orgId, opts.orgId))
    .orderBy(desc(ruleExecutions.ranAt))
    .limit(opts.limit ?? 50);
}
