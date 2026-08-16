"use client";

import { useState, useTransition, useEffect, useCallback } from "react";
import { Pause, Play, X, ChevronDown, ChevronRight } from "lucide-react";
import { AdCard } from "./AdCard";
import { AdQuickAction } from "./AdActions";
import { bulkSetAdStatus } from "./action-mutations";
import { cn } from "@/lib/utils";
import type { AdCardData } from "@/lib/db/queries/dashboard";

const COLLAPSED_KEY = "dashboard.collapsedAccounts.v1";

function loadCollapsed(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function saveCollapsed(s: Set<string>) {
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...s])); } catch {}
}

export function AdGrid({
  cards,
  groupTotals,
}: {
  cards: AdCardData[];
  /** ad-account name → total matching ads in the FULL filtered set. When the
   *  page caps the cards it ships here, headers show "X of Y ads" so a
   *  partially-loaded group doesn't read as the whole account. */
  groupTotals?: Record<string, number>;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [bulkResult, setBulkResult] = useState<{
    ok: number;
    failed: number;
  } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => { setCollapsed(loadCollapsed()); }, []);

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsed(next);
      return next;
    });
  }, []);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clear = () => setSelected(new Set());

  const runBulk = (status: "ACTIVE" | "PAUSED") => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    startTransition(async () => {
      setBulkResult(null);
      const r = await bulkSetAdStatus(ids, status);
      if ("error" in r) {
        setBulkResult({ ok: 0, failed: ids.length });
      } else {
        setBulkResult({ ok: r.ok, failed: r.failed });
        clear();
      }
    });
  };

  // Group cards by ad account, preserving order of first appearance.
  const groups: { accountName: string; cards: AdCardData[] }[] = [];
  const accountIndex = new Map<string, number>();
  for (const c of cards) {
    let idx = accountIndex.get(c.adAccountName);
    if (idx === undefined) {
      idx = groups.length;
      accountIndex.set(c.adAccountName, idx);
      groups.push({ accountName: c.adAccountName, cards: [] });
    }
    groups[idx].cards.push(c);
  }

  return (
    <div className="relative flex flex-1 flex-col gap-0">
      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.accountName);
        return (
          <div key={group.accountName}>
            <button
              type="button"
              onClick={() => toggleCollapsed(group.accountName)}
              aria-expanded={!isCollapsed}
              aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${group.accountName}`}
              className="sticky top-0 z-10 flex w-full items-center justify-between border-b border-zinc-200 bg-zinc-100 px-6 py-2 text-left text-[11px] font-semibold text-zinc-700 hover:bg-zinc-200/60 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800/60"
            >
              <span className="flex items-center gap-1.5">
                {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                <span>
                  {group.accountName}
                  <span className="ml-1 font-normal text-zinc-500">
                    ·{" "}
                    {(groupTotals?.[group.accountName] ?? 0) > group.cards.length
                      ? `${group.cards.length} of ${groupTotals![group.accountName]} ads`
                      : `${group.cards.length} ad${group.cards.length === 1 ? "" : "s"}`}
                  </span>
                </span>
              </span>
            </button>
            {!isCollapsed && (
              <div className="grid grid-cols-1 gap-3 p-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {group.cards.map((c) => {
                  const isSelected = selected.has(c.id);
                  const isPaused =
                    c.effectiveStatus === "PAUSED" ||
                    c.effectiveStatus === "CAMPAIGN_PAUSED" ||
                    c.effectiveStatus === "ADSET_PAUSED";
                  return (
                    <div
                      key={c.id}
                      className={cn(
                        // content-visibility lets the browser skip layout/paint
                        // for offscreen cards; the intrinsic-size estimate only
                        // matters before a card's first paint.
                        "relative rounded-lg ring-2 ring-transparent transition-all [contain-intrinsic-size:auto_240px] [content-visibility:auto]",
                        isSelected && "ring-blue-500",
                      )}
                    >
                      <button
                        type="button"
                        aria-label={isSelected ? "Deselect" : "Select"}
                        onClick={() => toggle(c.id)}
                        className={cn(
                          "absolute left-1.5 top-1.5 z-10 h-4 w-4 rounded border bg-white transition-colors",
                          isSelected
                            ? "border-blue-500 bg-blue-500"
                            : "border-zinc-300 hover:border-zinc-400 dark:border-zinc-700",
                        )}
                      >
                        {isSelected ? (
                          <svg
                            viewBox="0 0 16 16"
                            fill="none"
                            className="h-full w-full text-white"
                          >
                            <path
                              d="M3 8.5l3 3 6-7"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                            />
                          </svg>
                        ) : null}
                      </button>
                      <div className="absolute right-1.5 top-1.5 z-10">
                        <AdQuickAction adId={c.id} isPaused={isPaused} />
                      </div>
                      <AdCard ad={c} />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {selected.size > 0 ? (
        <div className="sticky bottom-4 mx-auto flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <span className="text-xs font-medium">
            {selected.size} selected
          </span>
          <div className="h-4 w-px bg-zinc-200 dark:bg-zinc-700" />
          <button
            type="button"
            disabled={pending}
            onClick={() => runBulk("PAUSED")}
            className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            <Pause className="h-3 w-3" />
            Pause all
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => runBulk("ACTIVE")}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            <Play className="h-3 w-3" />
            Resume all
          </button>
          <button
            type="button"
            onClick={clear}
            className="inline-flex items-center gap-1 rounded-md p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            aria-label="Clear selection"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      {bulkResult ? (
        <div className="sticky bottom-4 mx-auto rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-700 shadow dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
          Bulk action: {bulkResult.ok} OK
          {bulkResult.failed ? ` · ${bulkResult.failed} failed` : ""}
        </div>
      ) : null}
    </div>
  );
}
