"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAppSession } from "@/lib/auth/session";
import { resolveActiveProject } from "@/lib/auth/active-project";
import {
  createRule,
  deleteRule,
  setRuleEnabled,
  listRules,
  type RuleRow,
} from "@/lib/db/queries/rules";
import { runRule, type RunRuleResult } from "@/lib/rules/runner";
import { db, schema } from "@/lib/db/client";
import { and, eq } from "drizzle-orm";
import {
  RuleConditionsSchema,
  type RuleConditions,
  type RuleAction,
  type RuleTrigger,
} from "@/lib/rules/types";

export type ActionState = { ok: boolean; message: string };

const CreateRuleSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().optional(),
  conditions: RuleConditionsSchema,
  action: z.enum(["pause", "notify"]),
  trigger: z.enum(["scheduled", "interval"]),
  schedule: z.string().optional(),
  intervalMinutes: z.number().int().min(5).max(1440).optional(),
  // 'project' = scope to active project (resolved server-side, ignoring any
  // client-supplied id); 'org' = applies to every project in the org.
  scope: z.enum(["project", "org"]),
});

export async function createRuleAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { ok: false, message: "Not signed in." };
  }

  let parsed;
  try {
    parsed = CreateRuleSchema.parse({
      name: formData.get("name"),
      description: formData.get("description") || undefined,
      conditions: JSON.parse(String(formData.get("conditions") ?? "[]")),
      action: formData.get("action"),
      trigger: formData.get("trigger"),
      schedule: formData.get("schedule") || undefined,
      intervalMinutes: formData.get("intervalMinutes")
        ? Number(formData.get("intervalMinutes"))
        : undefined,
      scope: formData.get("scope") || "org",
    });
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Invalid input",
    };
  }

  if (parsed.trigger === "interval" && !parsed.intervalMinutes) {
    return { ok: false, message: "intervalMinutes required for interval trigger" };
  }
  if (parsed.trigger === "scheduled" && !parsed.schedule) {
    return { ok: false, message: "schedule (cron) required for scheduled trigger" };
  }

  // Resolve project scope server-side — never trust a client-supplied ID for
  // tenant-bound assignment.
  let appliesToProjectId: string | null = null;
  if (parsed.scope === "project") {
    const active = await resolveActiveProject({
      orgId: session.orgId,
      userId: session.userId,
    });
    if (!active) {
      return {
        ok: false,
        message:
          "No active project — pick one in the topbar or choose Org-wide scope.",
      };
    }
    appliesToProjectId = active.id;
  }

  await createRule({
    orgId: session.orgId,
    name: parsed.name,
    description: parsed.description ?? null,
    scope: "ad",
    conditions: parsed.conditions,
    action: parsed.action,
    trigger: parsed.trigger,
    schedule: parsed.schedule ?? null,
    intervalMinutes: parsed.intervalMinutes ?? null,
    appliesToProjectId,
    createdBy: session.userId,
  });
  revalidatePath("/rules");
  return { ok: true, message: `Created rule "${parsed.name}".` };
}

export async function toggleRuleAction(formData: FormData): Promise<void> {
  const ruleId = String(formData.get("ruleId") ?? "");
  const enabled = String(formData.get("enabled") ?? "false") === "true";
  if (!ruleId) return;
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return;
  }
  await setRuleEnabled({ orgId: session.orgId, ruleId, enabled });
  revalidatePath("/rules");
}

/**
 * Dry-run a rule and return what it *would* have paused.
 *
 * There is deliberately no `dryRun` parameter. Live enforcement for both ad
 * accounts belongs to the parent AI Ads Agent app; letting this action take
 * `dryRun` from the client would give the browser a one-click path to pause
 * real ads from a page that promises it makes no Meta write calls.
 * `runRule({ dryRun: true })` makes no Meta write calls.
 */
export async function runRuleNowAction(opts: {
  ruleId: string;
}): Promise<RunRuleResult | { error: string }> {
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { error: "Not signed in." };
  }
  const [rule] = await db
    .select()
    .from(schema.automatedRules)
    .where(
      and(
        eq(schema.automatedRules.orgId, session.orgId),
        eq(schema.automatedRules.id, opts.ruleId),
      ),
    )
    .limit(1);
  if (!rule) return { error: "Rule not found." };
  const r = await runRule({ rule, dryRun: true });
  revalidatePath("/rules");
  return r;
}

/**
 * Seed Andi's 3 production rules. Idempotent on name within the active
 * project (skips if a same-name rule already exists).
 */
export async function seedAndiRulesAction(): Promise<ActionState> {
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { ok: false, message: "Not signed in." };
  }
  const active = await resolveActiveProject({
    orgId: session.orgId,
    userId: session.userId,
  });
  if (!active) return { ok: false, message: "No active project." };

  const existing = (await listRules(session.orgId))
    .filter((r) => r.appliesToProjectId === active.id)
    .map((r) => r.name);

  let created = 0;
  for (const preset of ANDI_PRESETS) {
    if (existing.includes(preset.name)) continue;
    await createRule({
      orgId: session.orgId,
      appliesToProjectId: active.id,
      createdBy: session.userId,
      scope: "ad",
      ...preset,
    });
    created += 1;
  }
  revalidatePath("/rules");
  return {
    ok: true,
    message: `Seeded ${created} rules into "${active.name}". (${ANDI_PRESETS.length - created} skipped — already existed.)`,
  };
}

const ANDI_PRESETS: Array<{
  name: string;
  description: string;
  conditions: RuleConditions;
  action: RuleAction;
  trigger: RuleTrigger;
  schedule: string | null;
  intervalMinutes: number | null;
}> = [
  {
    name: "Pause if RM45 spent w/ <2 results yesterday",
    description: "Daily at 00:00 KL. Mirrors your existing automated rule #1.",
    conditions: [
      { metric: "spend", op: ">", value: 45, window: "yesterday" },
      { metric: "results", op: "<", value: 2, window: "yesterday" },
    ],
    action: "pause",
    trigger: "scheduled",
    schedule: "0 0 * * *",
    intervalMinutes: null,
  },
  {
    name: "Pause if RM40 spent w/ <1 result yesterday",
    description: "Daily at 00:00 KL. Mirrors your existing automated rule #2.",
    conditions: [
      { metric: "spend", op: ">", value: 40, window: "yesterday" },
      { metric: "results", op: "<", value: 1, window: "yesterday" },
    ],
    action: "pause",
    trigger: "scheduled",
    schedule: "0 0 * * *",
    intervalMinutes: null,
  },
  {
    name: "Pause if RM75 spent today w/ <2 results",
    description: "Every 30 min. Mirrors your existing automated rule #3.",
    conditions: [
      { metric: "spend", op: ">", value: 75, window: "today" },
      { metric: "results", op: "<", value: 2, window: "today" },
    ],
    action: "pause",
    trigger: "interval",
    schedule: null,
    intervalMinutes: 30,
  },
];

export async function deleteRuleAction(ruleId: string): Promise<ActionState> {
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { ok: false, message: "Not signed in." };
  }
  await deleteRule({ orgId: session.orgId, ruleId });
  revalidatePath("/rules");
  return { ok: true, message: "Rule deleted." };
}
