"use client";

import { useState, useTransition } from "react";
import { Play, FlaskConical, Trash2 } from "lucide-react";
import { runRuleNowAction, toggleRuleAction, deleteRuleAction } from "./actions";
import type { RunRuleResult } from "@/lib/rules/runner";
import { cn, formatMyr, formatNumber } from "@/lib/utils";

type Props = {
  rule: {
    id: string;
    name: string;
    description: string | null;
    enabled: boolean;
    trigger: string;
    schedule: string | null;
    intervalMinutes: number | null;
    action: string;
    lastRanAt: Date | null;
    appliesToProjectId: string | null;
    conditions: Array<{
      metric: string;
      op: string;
      value: number;
      window: string;
    }>;
  };
};

export function RuleRow({ rule }: Props) {
  const [pending, startTransition] = useTransition();
  const [latest, setLatest] = useState<RunRuleResult | { error: string } | null>(
    null,
  );
  const isError = latest && "error" in latest;

  const run = (dryRun: boolean) => {
    startTransition(async () => {
      const r = await runRuleNowAction({ ruleId: rule.id, dryRun });
      setLatest(r);
    });
  };

  const toggle = () => {
    const fd = new FormData();
    fd.set("ruleId", rule.id);
    fd.set("enabled", String(!rule.enabled));
    startTransition(async () => {
      await toggleRuleAction(fd);
    });
  };

  const remove = () => {
    if (!confirm(`Delete rule "${rule.name}"? This cannot be undone.`)) return;
    startTransition(async () => {
      await deleteRuleAction(rule.id);
    });
  };

  const cadence =
    rule.trigger === "interval"
      ? `every ${rule.intervalMinutes} min`
      : `cron ${rule.schedule}`;

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{rule.name}</span>
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider",
                rule.enabled
                  ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                  : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
              )}
            >
              {rule.enabled ? "enabled" : "disabled"}
            </span>
          </div>
          {rule.description ? (
            <p className="text-xs text-zinc-500">{rule.description}</p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
            {rule.conditions.map((c, i) => (
              <span
                key={i}
                className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] dark:bg-zinc-800"
              >
                {c.metric}({c.window}) {c.op} {c.value}
              </span>
            ))}
            <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300">
              {rule.action}
            </span>
            <span className="text-zinc-400">·</span>
            <span className="text-zinc-500">{cadence}</span>
            {rule.lastRanAt ? (
              <>
                <span className="text-zinc-400">·</span>
                <span className="text-zinc-500">
                  last ran{" "}
                  {new Date(rule.lastRanAt).toLocaleString("en-MY", {
                    timeZone: "Asia/Kuala_Lumpur",
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              </>
            ) : null}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={toggle}
              disabled={pending}
              className={cn(
                "rounded-md px-2.5 py-1 text-[11px] font-medium",
                rule.enabled
                  ? "border border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                  : "bg-emerald-600 text-white hover:bg-emerald-700",
              )}
            >
              {rule.enabled ? "Disable" : "Enable"}
            </button>
            <button
              type="button"
              onClick={remove}
              disabled={pending}
              title="Delete rule"
              className="rounded-md p-1 text-zinc-400 hover:bg-red-50 hover:text-red-500 disabled:opacity-50 dark:hover:bg-red-950"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => run(true)}
              disabled={pending}
              className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
            >
              <FlaskConical className="h-3 w-3" />
              Dry run
            </button>
            <button
              type="button"
              onClick={() => run(false)}
              disabled={pending || !rule.enabled}
              title={!rule.enabled ? "Enable the rule first" : "Run now"}
              className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Play className="h-3 w-3" />
              Run now
            </button>
          </div>
        </div>
      </div>

      {pending ? (
        <p className="mt-3 text-[11px] text-zinc-500">Running…</p>
      ) : null}
      {latest && !isError ? (
        <ResultPanel rule={rule} result={latest as RunRuleResult} />
      ) : null}
      {isError ? (
        <p className="mt-3 text-xs text-red-600">
          {(latest as { error: string }).error}
        </p>
      ) : null}
    </div>
  );
}

function ResultPanel({
  rule,
  result,
}: {
  rule: Props["rule"];
  result: RunRuleResult;
}) {
  return (
    <div className="mt-3 rounded-md border border-zinc-100 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-xs font-medium">
        {result.dryRun ? "Dry run:" : "Executed:"}{" "}
        {result.matched} matched
        {!result.dryRun && (
          <>
            {" "}
            · {result.actionsTaken} {rule.action === "pause" ? "paused" : "actioned"}
            {result.actionsFailed
              ? ` · ${result.actionsFailed} failed`
              : ""}
          </>
        )}{" "}
        · {result.totalAdsConsidered} considered
      </p>
      {result.error ? (
        <p className="mt-1 text-xs text-red-600">{result.error}</p>
      ) : null}
      {result.perAd.length > 0 ? (
        <div className="mt-2 max-h-64 overflow-y-auto">
          <table className="w-full text-left text-[11px]">
            <thead className="text-[9px] uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="py-1">Ad</th>
                <th className="py-1">Metrics</th>
                <th className="py-1">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {result.perAd.map((p) => (
                <tr key={p.adId}>
                  <td className="py-1.5">{p.name}</td>
                  <td className="py-1.5 font-mono text-[10px]">
                    {p.values
                      .map(
                        (v) =>
                          `${v.metric}=${formatMetricValue(v.metric, v.value)} ${v.op} ${v.threshold}`,
                      )
                      .join(" · ")}
                  </td>
                  <td className="py-1.5">
                    {result.dryRun ? (
                      <span className="text-amber-600">would pause</span>
                    ) : p.ok ? (
                      <span className="text-emerald-600">paused</span>
                    ) : (
                      <span className="text-red-600">{p.error ?? "failed"}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-2 text-[11px] text-zinc-500">No matches.</p>
      )}
    </div>
  );
}

function formatMetricValue(metric: string, value: number | null): string {
  if (value === null) return "—";
  if (metric === "spend" || metric === "cost_per_result" || metric === "cpm" || metric === "cpc") {
    return formatMyr(value);
  }
  if (metric === "ctr") return `${value.toFixed(2)}%`;
  if (metric === "purchase_roas") return `${value.toFixed(2)}x`;
  return formatNumber(value);
}
