import { z } from "zod";

/**
 * Rule definition shape stored in `automated_rules.conditions`.
 *
 * Phase 3 MVP supports a flat AND of metric thresholds. Phase 3.x will add
 * nested condition trees (OR groups, NOT, parentheses).
 */

export const RULE_METRICS = [
  "spend",
  "results",
  "cost_per_result",
  "ctr",
  "cpm",
  "cpc",
  "purchase_roas",
  "impressions",
  "clicks",
  "frequency",
] as const;

export type RuleMetric = (typeof RULE_METRICS)[number];

export const RULE_OPS = [">", ">=", "<", "<=", "==", "!="] as const;

export type RuleOp = (typeof RULE_OPS)[number];

/**
 * Time window for evaluating a metric.
 * - today / yesterday — single calendar day in org tz
 * - last_3d / last_7d / last_30d — rolling window ending yesterday
 * - lifetime — all-time aggregate from cache
 */
export const RULE_WINDOWS = [
  "today",
  "yesterday",
  "last_3d",
  "last_7d",
  "last_30d",
  "lifetime",
] as const;

export type RuleWindow = (typeof RULE_WINDOWS)[number];

export const RuleConditionSchema = z.object({
  metric: z.enum(RULE_METRICS),
  op: z.enum(RULE_OPS),
  value: z.number(),
  window: z.enum(RULE_WINDOWS),
});

export type RuleCondition = z.infer<typeof RuleConditionSchema>;

/** AND of N conditions. Empty array = matches everything (don't ship that). */
export const RuleConditionsSchema = z
  .array(RuleConditionSchema)
  .min(1, "At least one condition is required");

export type RuleConditions = z.infer<typeof RuleConditionsSchema>;

export const RULE_ACTIONS = ["pause", "notify"] as const;

export type RuleAction = (typeof RULE_ACTIONS)[number];

export const RULE_TRIGGERS = ["scheduled", "interval"] as const;

export type RuleTrigger = (typeof RULE_TRIGGERS)[number];

/**
 * Compare op helper. Returns true if `lhs op rhs` holds.
 * `null` on either side = no match (rule won't fire on missing data).
 */
export function compare(
  op: RuleOp,
  lhs: number | null,
  rhs: number,
): boolean {
  if (lhs === null || !Number.isFinite(lhs)) return false;
  switch (op) {
    case ">": return lhs > rhs;
    case ">=": return lhs >= rhs;
    case "<": return lhs < rhs;
    case "<=": return lhs <= rhs;
    case "==": return lhs === rhs;
    case "!=": return lhs !== rhs;
  }
}
