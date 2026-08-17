"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { X, Plus, Trash2 } from "lucide-react";
import { createRuleAction, type ActionState } from "./actions";
import {
  RULE_METRICS,
  RULE_OPS,
  RULE_WINDOWS,
  type RuleMetric,
  type RuleOp,
  type RuleWindow,
} from "@/lib/rules/types";
import { cn } from "@/lib/utils";

type ConditionRow = {
  metric: RuleMetric;
  op: RuleOp;
  value: string;
  window: RuleWindow;
};

const DEFAULT_CONDITION: ConditionRow = {
  metric: "spend",
  op: ">",
  value: "",
  window: "yesterday",
};

/**
 * KL is UTC+8 with no DST, and cron runs in UTC — so a preset is the KL hour
 * minus 8. Times before 08:00 KL wrap to the previous UTC day, which is why
 * 00:00 KL is `0 16 * * *` and not `0 0 * * *`.
 *
 * Computed rather than hand-written: 16 literal cron strings is 16 chances to
 * fat-finger an hour, and an off-by-one here would fire a pause at the wrong
 * time of day.
 */
function klCron(hour: number, minute = 0): string {
  return `${minute} ${(hour - 8 + 24) % 24} * * *`;
}

function klLabel(hour: number, minute = 0): string {
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return `Daily ${hh}:${mm} KL`;
}

const SCHEDULE_PRESETS: Array<{ label: string; cron: string }> = [
  // Overnight + morning
  [0, 0],
  [8, 0],
  [9, 0],
  // Midday through end of day, hourly
  [12, 0],
  [13, 0],
  [14, 0],
  [15, 0],
  [16, 0],
  [17, 0],
  [18, 0],
  [19, 0],
  [20, 0],
  [21, 0],
  [22, 0],
  [23, 0],
  // Last call before midnight — catches the day before spend resets.
  [23, 30],
].map(([h, m]) => ({ label: klLabel(h, m), cron: klCron(h, m) }));

const INTERVAL_PRESETS = [
  { label: "15 min", minutes: 15 },
  { label: "30 min", minutes: 30 },
  { label: "1 hour", minutes: 60 },
  { label: "4 hours", minutes: 240 },
];

const METRIC_LABELS: Record<RuleMetric, string> = {
  spend: "Spend (RM)",
  results: "Results",
  cost_per_result: "Cost/result (RM)",
  ctr: "CTR (%)",
  cpm: "CPM (RM)",
  cpc: "CPC (RM)",
  purchase_roas: "Purchase ROAS",
  impressions: "Impressions",
  clicks: "Clicks",
  frequency: "Frequency",
};

type Preset = {
  id: string;
  label: string;
  conditions: ConditionRow[];
  trigger: "scheduled" | "interval";
  schedule: string | null;
  intervalMinutes: number | null;
  defaultName: string;
};

const PRESETS: Preset[] = [
  {
    id: "pause-45",
    label: "Pause if RM45 spent w/ <2 results yesterday",
    conditions: [
      { metric: "spend", op: ">", value: "45", window: "yesterday" },
      { metric: "results", op: "<", value: "2", window: "yesterday" },
    ],
    trigger: "scheduled",
    schedule: "0 0 * * *",
    intervalMinutes: null,
    defaultName: "Pause if RM45 spent w/ <2 results yesterday",
  },
  {
    id: "pause-40",
    label: "Pause if RM40 spent w/ <1 result yesterday",
    conditions: [
      { metric: "spend", op: ">", value: "40", window: "yesterday" },
      { metric: "results", op: "<", value: "1", window: "yesterday" },
    ],
    trigger: "scheduled",
    schedule: "0 0 * * *",
    intervalMinutes: null,
    defaultName: "Pause if RM40 spent w/ <1 result yesterday",
  },
  {
    id: "pause-75-today",
    label: "Pause if RM75 spent today w/ <2 results (every 30m)",
    conditions: [
      { metric: "spend", op: ">", value: "75", window: "today" },
      { metric: "results", op: "<", value: "2", window: "today" },
    ],
    trigger: "interval",
    schedule: null,
    intervalMinutes: 30,
    defaultName: "Pause if RM75 spent today w/ <2 results",
  },
];

type Props = {
  open: boolean;
  onClose: () => void;
  /** Active project — used to label the project-scope option and default name. */
  activeProjectName: string | null;
};

export function CreateRuleDialog({ open, onClose, activeProjectName }: Props) {
  const [state, formAction, isPending] = useActionState<ActionState | null, FormData>(
    createRuleAction,
    null,
  );

  const [conditions, setConditions] = useState<ConditionRow[]>([
    { ...DEFAULT_CONDITION },
  ]);
  const [trigger, setTrigger] = useState<"scheduled" | "interval">("scheduled");
  const [schedule, setSchedule] = useState("0 16 * * *");
  const [intervalMinutes, setIntervalMinutes] = useState<number>(30);
  const [customInterval, setCustomInterval] = useState("");
  // Default to project scope — most rules the operator creates are about a
  // single brand. Org-wide stays available for cross-project policies.
  const [scope, setScope] = useState<"project" | "org">(
    activeProjectName ? "project" : "org",
  );
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const formRef = useRef<HTMLFormElement>(null);

  // Close on success
  useEffect(() => {
    if (state?.ok) {
      onClose();
      resetForm();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, onClose]);

  // Reset on open
  useEffect(() => {
    if (open) resetForm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function resetForm() {
    setConditions([{ ...DEFAULT_CONDITION }]);
    setTrigger("scheduled");
    setSchedule("0 16 * * *");
    setIntervalMinutes(30);
    setCustomInterval("");
    setScope(activeProjectName ? "project" : "org");
    setName("");
    setDescription("");
  }

  function applyPreset(preset: Preset) {
    setConditions(preset.conditions.map((c) => ({ ...c })));
    setTrigger(preset.trigger);
    if (preset.schedule) setSchedule(preset.schedule);
    if (preset.intervalMinutes !== null) {
      setIntervalMinutes(preset.intervalMinutes);
      setCustomInterval("");
    }
    if (!name) setName(preset.defaultName);
  }

  if (!open) return null;

  const addCondition = () =>
    setConditions((prev) => [...prev, { ...DEFAULT_CONDITION }]);

  const removeCondition = (i: number) =>
    setConditions((prev) => prev.filter((_, idx) => idx !== i));

  const updateCondition = <K extends keyof ConditionRow>(
    i: number,
    field: K,
    value: ConditionRow[K],
  ) =>
    setConditions((prev) =>
      prev.map((c, idx) => (idx === i ? { ...c, [field]: value } : c)),
    );

  const resolvedInterval =
    customInterval && Number(customInterval) >= 5
      ? Number(customInterval)
      : intervalMinutes;

  const conditionsJson = JSON.stringify(
    conditions.map((c) => ({
      metric: c.metric,
      op: c.op,
      value: Number(c.value) || 0,
      window: c.window,
    })),
  );

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="w-full max-w-xl rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-950">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
            <h2 className="text-sm font-semibold">New Automated Rule</h2>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Form */}
          <form
            ref={formRef}
            action={formAction}
            className="flex max-h-[80vh] flex-col overflow-y-auto"
          >
            <div className="flex flex-col gap-5 p-5">
              {/* Hidden serialised conditions + scope */}
              <input type="hidden" name="conditions" value={conditionsJson} />
              <input type="hidden" name="scope" value={scope} />

              {/* Preset chips — one click prefills conditions + trigger */}
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-medium text-zinc-500">
                  Start from preset (optional)
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {PRESETS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => applyPreset(p)}
                      className="rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-[11px] text-zinc-700 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-blue-700 dark:hover:bg-blue-950 dark:hover:text-blue-300"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Name */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium">Rule name *</label>
                <input
                  name="name"
                  value={name}
                  onChange={(e) => setName(e.currentTarget.value)}
                  required
                  maxLength={120}
                  placeholder="e.g. Pause if RM50 spent with <1 result"
                  className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
                />
              </div>

              {/* Description */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium">
                  Description{" "}
                  <span className="font-normal text-zinc-400">(optional)</span>
                </label>
                <input
                  name="description"
                  value={description}
                  onChange={(e) => setDescription(e.currentTarget.value)}
                  maxLength={300}
                  placeholder="What does this rule do?"
                  className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
                />
              </div>

              {/* Scope */}
              <div className="flex flex-col gap-2">
                <label className="text-xs font-medium">Scope</label>
                <div className="flex gap-2">
                  {(
                    [
                      {
                        id: "project",
                        label: activeProjectName
                          ? `Only: ${activeProjectName}`
                          : "Only: active project",
                        disabled: !activeProjectName,
                      },
                      {
                        id: "org",
                        label: "Org-wide (all projects)",
                        disabled: false,
                      },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => !opt.disabled && setScope(opt.id)}
                      disabled={opt.disabled}
                      className={cn(
                        "flex-1 rounded-lg border py-2 text-xs font-medium transition-colors disabled:opacity-50",
                        scope === opt.id
                          ? "border-blue-500 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-950 dark:text-blue-300"
                          : "border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900",
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Conditions */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium">Conditions (ALL must match)</label>
                  <button
                    type="button"
                    onClick={addCondition}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950"
                  >
                    <Plus className="h-3 w-3" />
                    Add
                  </button>
                </div>

                <div className="flex flex-col gap-2">
                  {conditions.map((cond, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 rounded-lg border border-zinc-100 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-900"
                    >
                      {/* Metric */}
                      <select
                        value={cond.metric}
                        onChange={(e) =>
                          updateCondition(i, "metric", e.target.value as RuleMetric)
                        }
                        className="flex-1 rounded border border-zinc-200 bg-white px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-950"
                      >
                        {RULE_METRICS.map((m) => (
                          <option key={m} value={m}>
                            {METRIC_LABELS[m]}
                          </option>
                        ))}
                      </select>

                      {/* Op */}
                      <select
                        value={cond.op}
                        onChange={(e) =>
                          updateCondition(i, "op", e.target.value as RuleOp)
                        }
                        className="w-16 rounded border border-zinc-200 bg-white px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-950"
                      >
                        {RULE_OPS.map((op) => (
                          <option key={op} value={op}>
                            {op}
                          </option>
                        ))}
                      </select>

                      {/* Value */}
                      <input
                        type="number"
                        step="any"
                        value={cond.value}
                        onChange={(e) => updateCondition(i, "value", e.target.value)}
                        placeholder="0"
                        className="w-20 rounded border border-zinc-200 bg-white px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-950"
                      />

                      {/* Window */}
                      <select
                        value={cond.window}
                        onChange={(e) =>
                          updateCondition(i, "window", e.target.value as RuleWindow)
                        }
                        className="w-28 rounded border border-zinc-200 bg-white px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-950"
                      >
                        {RULE_WINDOWS.map((w) => (
                          <option key={w} value={w}>
                            {w}
                          </option>
                        ))}
                      </select>

                      {/* Remove */}
                      {conditions.length > 1 ? (
                        <button
                          type="button"
                          onClick={() => removeCondition(i)}
                          className="rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      ) : (
                        <div className="w-6" />
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Action */}
              <div className="flex flex-col gap-2">
                <label className="text-xs font-medium">Action when matched</label>
                <div className="flex gap-2">
                  {(
                    [
                      { id: "pause", label: "⏸ Pause ad", note: "" },
                      {
                        id: "notify",
                        label: "🔔 Notify only",
                        note: "soon",
                      },
                    ] as const
                  ).map((a) => (
                    <label
                      key={a.id}
                      className={cn(
                        "flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border py-2.5 text-xs font-medium transition-colors",
                        "has-[:checked]:border-blue-500 has-[:checked]:bg-blue-50 has-[:checked]:text-blue-700",
                        "dark:has-[:checked]:border-blue-500 dark:has-[:checked]:bg-blue-950 dark:has-[:checked]:text-blue-300",
                        "border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900",
                      )}
                    >
                      <input
                        type="radio"
                        name="action"
                        value={a.id}
                        defaultChecked={a.id === "pause"}
                        className="sr-only"
                      />
                      {a.label}
                      {a.note ? (
                        <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                          {a.note}
                        </span>
                      ) : null}
                    </label>
                  ))}
                </div>
              </div>

              {/* Trigger */}
              <div className="flex flex-col gap-2">
                <label className="text-xs font-medium">Trigger</label>
                <input type="hidden" name="trigger" value={trigger} />
                <div className="flex gap-2">
                  {(["scheduled", "interval"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTrigger(t)}
                      className={cn(
                        "flex-1 rounded-lg border py-2 text-xs font-medium transition-colors",
                        trigger === t
                          ? "border-blue-500 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-950 dark:text-blue-300"
                          : "border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900",
                      )}
                    >
                      {t === "scheduled" ? "📅 Scheduled (cron)" : "⏱ Interval"}
                    </button>
                  ))}
                </div>

                {trigger === "scheduled" ? (
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap gap-1.5">
                      {SCHEDULE_PRESETS.map((p) => (
                        <button
                          key={p.cron}
                          type="button"
                          onClick={() => setSchedule(p.cron)}
                          className={cn(
                            "rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors",
                            schedule === p.cron
                              ? "border-blue-500 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-950 dark:text-blue-300"
                              : "border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300",
                          )}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-[11px] text-zinc-500">Custom cron (UTC):</label>
                      <input
                        type="text"
                        name="schedule"
                        value={schedule}
                        onChange={(e) => setSchedule(e.target.value)}
                        placeholder="0 16 * * *"
                        className="flex-1 rounded border border-zinc-200 bg-white px-2 py-1.5 font-mono text-[11px] focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
                      />
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <input
                      type="hidden"
                      name="intervalMinutes"
                      value={resolvedInterval}
                    />
                    <div className="flex flex-wrap gap-1.5">
                      {INTERVAL_PRESETS.map((p) => (
                        <button
                          key={p.minutes}
                          type="button"
                          onClick={() => {
                            setIntervalMinutes(p.minutes);
                            setCustomInterval("");
                          }}
                          className={cn(
                            "rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors",
                            intervalMinutes === p.minutes && !customInterval
                              ? "border-blue-500 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-950 dark:text-blue-300"
                              : "border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300",
                          )}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-[11px] text-zinc-500">Custom (min, ≥5):</label>
                      <input
                        type="number"
                        min={5}
                        max={1440}
                        value={customInterval}
                        onChange={(e) => {
                          setCustomInterval(e.target.value);
                          if (e.target.value) setIntervalMinutes(0);
                        }}
                        placeholder="e.g. 45"
                        className="w-24 rounded border border-zinc-200 bg-white px-2 py-1.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Error */}
              {state && !state.ok ? (
                <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
                  {state.message}
                </p>
              ) : null}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 border-t border-zinc-100 px-5 py-4 dark:border-zinc-800">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-zinc-200 px-4 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isPending}
                className="rounded-md bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {isPending ? "Creating…" : "Create rule"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
