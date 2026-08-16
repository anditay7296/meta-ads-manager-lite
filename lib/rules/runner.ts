import { evaluateRule, type EvaluateResult } from "./engine";
import { setAdStatusAction } from "@/lib/meta/actions";
import {
  logRuleExecution,
  recordRuleRan,
  type RuleRow,
} from "@/lib/db/queries/rules";

export type RunRuleResult = {
  ruleId: string;
  ruleName: string;
  matched: number;
  actionsTaken: number;
  actionsFailed: number;
  dryRun: boolean;
  totalAdsConsidered: number;
  perAd: Array<{
    adId: string;
    metaAdId: string;
    name: string;
    ok: boolean;
    error?: string;
    values: EvaluateResult["matches"][number]["values"];
  }>;
  error?: string;
};

/**
 * Run a single rule. If `dryRun=true`, evaluates and logs but does not call
 * Meta. Always inserts a `rule_executions` row + journals every action.
 */
export async function runRule(opts: {
  rule: RuleRow;
  dryRun: boolean;
}): Promise<RunRuleResult> {
  const { rule, dryRun } = opts;
  try {
    const result = await evaluateRule(rule);
    const perAd: RunRuleResult["perAd"] = [];
    let actionsTaken = 0;
    let actionsFailed = 0;

    if (!dryRun && rule.action === "pause") {
      for (const m of result.matches) {
        const ar = await setAdStatusAction({
          orgId: rule.orgId,
          adId: m.adId,
          status: "PAUSED",
          actor: { type: "rule", ruleId: rule.id },
          reasoning: `Rule "${rule.name}" matched: ${m.values
            .map(
              (v) =>
                `${v.metric}(${v.window}) ${v.op} ${v.threshold} (was ${v.value ?? "null"})`,
            )
            .join(" AND ")}`,
        });
        if (ar.ok) actionsTaken += 1;
        else actionsFailed += 1;
        perAd.push({
          adId: m.adId,
          metaAdId: m.metaAdId,
          name: m.name,
          ok: ar.ok,
          error: ar.message,
          values: m.values,
        });
      }
    } else {
      // Dry-run or unsupported action: just record matches, no Meta call.
      for (const m of result.matches) {
        perAd.push({
          adId: m.adId,
          metaAdId: m.metaAdId,
          name: m.name,
          ok: true,
          values: m.values,
        });
      }
    }

    await logRuleExecution({
      orgId: rule.orgId,
      ruleId: rule.id,
      matched: result.matches.length,
      actionsTaken,
      dryRun,
      summary: {
        totalAdsConsidered: result.totalAdsConsidered,
        actionsFailed,
        perAd: perAd.slice(0, 100), // cap stored detail
      },
    });
    if (!dryRun) {
      await recordRuleRan({ ruleId: rule.id });
    }

    return {
      ruleId: rule.id,
      ruleName: rule.name,
      matched: result.matches.length,
      actionsTaken,
      actionsFailed,
      dryRun,
      totalAdsConsidered: result.totalAdsConsidered,
      perAd,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logRuleExecution({
      orgId: rule.orgId,
      ruleId: rule.id,
      matched: 0,
      actionsTaken: 0,
      dryRun,
      summary: null,
      error: message,
    });
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      matched: 0,
      actionsTaken: 0,
      actionsFailed: 0,
      dryRun,
      totalAdsConsidered: 0,
      perAd: [],
      error: message,
    };
  }
}
