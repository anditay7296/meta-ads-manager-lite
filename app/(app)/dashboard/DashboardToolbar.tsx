"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Search, X } from "lucide-react";
import { refreshDashboard, type SyncState } from "./actions";
import { cn } from "@/lib/utils";

const RANGES: { id: "today" | "yesterday" | "last_7d" | "last_30d"; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "last_7d", label: "Last 7d" },
  { id: "last_30d", label: "Last 30d" },
];

const initial: SyncState = { ok: false, message: "" };

export type DashboardView = "all" | "keep" | "kill";
export type DashboardSort = "newest" | "spend";

export function DashboardToolbar({
  activeRange,
  search,
  campaign,
  campaignOptions,
  alertsOnly,
  activeOnly,
  view,
  sort,
  counts,
}: {
  activeRange: "today" | "yesterday" | "last_7d" | "last_30d" | "max";
  search?: string;
  campaign?: string;
  campaignOptions?: string[];
  alertsOnly?: boolean;
  activeOnly?: boolean;
  view?: DashboardView;
  sort?: DashboardSort;
  counts?: { all: number; keep: number; kill: number };
}) {
  const [state, action, pending] = useActionState(refreshDashboard, initial);
  const router = useRouter();
  const [searchInput, setSearchInput] = useState(search ?? "");

  const buildUrl = (next: {
    range?: string;
    q?: string;
    campaign?: string;
    alerts?: boolean;
    active?: boolean;
    view?: DashboardView;
    sort?: DashboardSort;
  }) => {
    const params = new URLSearchParams();
    params.set("range", next.range ?? activeRange);
    const q = next.q !== undefined ? next.q : (search ?? "");
    const c = next.campaign !== undefined ? next.campaign : (campaign ?? "");
    const a = next.alerts !== undefined ? next.alerts : Boolean(alertsOnly);
    // activeOnly defaults true; only add param when turning off (active=0)
    const ao = next.active !== undefined ? next.active : Boolean(activeOnly);
    const v: DashboardView =
      next.view ?? (view ?? "all");
    // sort defaults to newest; only add param when set to spend
    const s: DashboardSort = next.sort ?? (sort ?? "newest");
    if (q) params.set("q", q);
    if (c) params.set("campaign", c);
    if (a) params.set("alerts", "1");
    if (!ao) params.set("active", "0");
    if (v !== "all") params.set("view", v);
    if (s === "spend") params.set("sort", "spend");
    return `/dashboard?${params.toString()}`;
  };

  const submitSearch = (e?: React.FormEvent) => {
    e?.preventDefault();
    router.push(buildUrl({ q: searchInput.trim() }));
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-white px-3 py-3 sm:px-6 dark:border-zinc-800 dark:bg-zinc-950">
      {/* w-full + min-w-0 on phones: without them this group keeps its
          max-content width (~800px), the parent clips it, and the sort /
          view / search controls become unreachable instead of wrapping. */}
      <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:gap-3">
        <div className="flex flex-wrap items-center gap-1">
          {RANGES.map((r) => {
            const isActive = r.id === activeRange;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => router.push(buildUrl({ range: r.id }))}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  isActive
                    ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                    : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900",
                )}
              >
                {r.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center rounded-md border border-zinc-200 dark:border-zinc-800">
          {(
            [
              { id: "newest", label: "Newest" },
              { id: "spend", label: "Top spend" },
            ] as Array<{ id: DashboardSort; label: string }>
          ).map((s, i) => {
            const isActive = (sort ?? "newest") === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => router.push(buildUrl({ sort: s.id }))}
                className={cn(
                  "px-2.5 py-1.5 text-xs font-medium transition-colors",
                  i === 0 && "rounded-l-md",
                  i === 1 && "rounded-r-md",
                  isActive
                    ? "bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                    : "text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-900",
                )}
              >
                {s.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center rounded-md border border-zinc-200 dark:border-zinc-800">
          {(
            [
              { id: "all", label: "All", emoji: null, count: counts?.all },
              { id: "keep", label: "Keep", emoji: "🟢", count: counts?.keep },
              { id: "kill", label: "Kill", emoji: "🔴", count: counts?.kill },
            ] as Array<{
              id: DashboardView;
              label: string;
              emoji: string | null;
              count: number | undefined;
            }>
          ).map((v, i) => {
            const isActive = (view ?? "all") === v.id;
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => router.push(buildUrl({ view: v.id }))}
                className={cn(
                  "inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium transition-colors",
                  i === 0 && "rounded-l-md",
                  i === 2 && "rounded-r-md",
                  isActive
                    ? v.id === "kill"
                      ? "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"
                      : v.id === "keep"
                        ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                        : "bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                    : "text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-900",
                )}
                title={`${v.label} ${v.count !== undefined ? `(${v.count})` : ""}`}
              >
                {v.emoji ? (
                  <span aria-hidden="true">{v.emoji}</span>
                ) : null}
                <span>{v.label}</span>
                {v.count !== undefined ? (
                  <span className="text-[10px] text-zinc-400">{v.count}</span>
                ) : null}
              </button>
            );
          })}
        </div>

        <form
          onSubmit={submitSearch}
          className="relative flex min-w-0 flex-1 items-center sm:flex-none"
        >
          <Search className="pointer-events-none absolute left-2 h-3 w-3 text-zinc-400" />
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.currentTarget.value)}
            placeholder="Search ad name…"
            className="w-full min-w-0 rounded-md border border-zinc-200 bg-white py-1 pl-7 pr-2 text-xs focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 sm:w-auto dark:border-zinc-800 dark:bg-zinc-950"
          />
          {searchInput ? (
            <button
              type="button"
              onClick={() => {
                setSearchInput("");
                router.push(buildUrl({ q: "" }));
              }}
              className="ml-1 rounded p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              aria-label="Clear search"
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </form>

        {campaignOptions && campaignOptions.length > 0 ? (
          <select
            value={campaign ?? ""}
            onChange={(e) =>
              router.push(buildUrl({ campaign: e.currentTarget.value }))
            }
            className="max-w-full min-w-0 truncate rounded-md border border-zinc-200 bg-white py-1 pl-2 pr-6 text-xs focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-800 dark:bg-zinc-950"
          >
            <option value="">All campaigns</option>
            {campaignOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        ) : null}

        <button
          type="button"
          onClick={() => router.push(buildUrl({ active: !activeOnly }))}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors",
            activeOnly
              ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
              : "border border-zinc-200 text-zinc-500 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900",
          )}
        >
          <span
            className={cn(
              "inline-block h-1.5 w-1.5 rounded-full",
              activeOnly ? "bg-emerald-500" : "bg-zinc-400",
            )}
          />
          Active only
        </button>

        <button
          type="button"
          onClick={() => router.push(buildUrl({ alerts: !alertsOnly }))}
          className={cn(
            "rounded-md px-3 py-1 text-xs font-medium transition-colors",
            alertsOnly
              ? "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"
              : "border border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900",
          )}
        >
          {alertsOnly ? "🔴 Alerts only" : "Alerts only"}
        </button>
      </div>

      <div className="flex items-center gap-3">
        {state.message ? (
          <span
            className={cn(
              "text-[11px]",
              state.ok ? "text-emerald-600" : "text-red-600",
            )}
          >
            {state.message}
          </span>
        ) : null}
        <form action={action}>
          <input type="hidden" name="range" value={activeRange} />
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", pending && "animate-spin")}
            />
            {pending ? "Syncing…" : "Refresh from Meta"}
          </button>
        </form>
      </div>
    </div>
  );
}
