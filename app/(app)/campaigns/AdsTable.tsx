"use client";

import { useMemo, useState, useTransition, useCallback, useEffect } from "react";
import Link from "next/link";
import { Copy, ExternalLink, ChevronDown, ChevronRight, Info } from "lucide-react";
import { AdStatusToggle } from "./AdStatusToggle";
import { BulkActionBar } from "./BulkActionBar";
import { ColumnChooser } from "./ColumnChooser";
import { formatMyr, formatNumber } from "@/lib/utils";
import { bulkToggleAdStatusAction } from "./actions";
import type { AdsByAdSet, AdManagerRow } from "@/lib/db/queries/manager";

type SortKey = "name" | "results" | "costPerResult" | "spend" | "ctr" | "purchaseRoas";

const TOGGLEABLE = [
  "Delivery",
  "Results",
  "Cost / result",
  "Amount spent",
  "Frequency",
  "CTR (all)",
  "Purchases",
  "Web purchases",
  "Purchase ROAS",
  "Conv. value",
] as const;

type ColLabel = typeof TOGGLEABLE[number];

const STORAGE_KEY = "ads_hidden_cols";
const COLLAPSED_KEY = "ads.collapsedAdSets.v1";

function loadHidden(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? new Set(JSON.parse(raw) as string[]) : new Set(); }
  catch { return new Set(); }
}
function saveHidden(s: Set<string>) { localStorage.setItem(STORAGE_KEY, JSON.stringify([...s])); }

function loadCollapsed(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try { const raw = localStorage.getItem(COLLAPSED_KEY); return raw ? new Set(JSON.parse(raw) as string[]) : new Set(); }
  catch { return new Set(); }
}
function saveCollapsed(s: Set<string>) { try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...s])); } catch {} }

export function AdsTable({
  groups,
  search,
  campaignFilter,
}: {
  groups: AdsByAdSet[];
  search: string;
  campaignFilter: string;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("spend");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [forceExpanded, setForceExpanded] = useState<Set<string>>(new Set());
  const [bulkPending, startBulkTransition] = useTransition();

  useEffect(() => { setHidden(loadHidden()); setCollapsed(loadCollapsed()); }, []);

  const toggleCollapsed = useCallback((key: string, isEmpty: boolean) => {
    setCollapsed((prevCollapsed) => {
      const wasCollapsed =
        prevCollapsed.has(key) || (isEmpty && !forceExpanded.has(key));
      if (wasCollapsed) {
        if (prevCollapsed.has(key)) {
          const next = new Set(prevCollapsed);
          next.delete(key);
          saveCollapsed(next);
          return next;
        }
        if (isEmpty) {
          setForceExpanded((prev) => new Set(prev).add(key));
        }
        return prevCollapsed;
      }
      const next = new Set(prevCollapsed);
      next.add(key);
      saveCollapsed(next);
      setForceExpanded((prev) => {
        if (!prev.has(key)) return prev;
        const n = new Set(prev);
        n.delete(key);
        return n;
      });
      return next;
    });
  }, [forceExpanded]);

  const toggleCol = useCallback((col: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      saveHidden(next);
      return next;
    });
  }, []);

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    return groups
      .filter((g) => !campaignFilter || g.campaignName === campaignFilter)
      .map((g) => ({
        ...g,
        adItems: q ? g.adItems.filter((a) => a.name.toLowerCase().includes(q)) : g.adItems,
      }))
      // Only drop empty ad-set groups while searching — at rest, ad sets with
      // zero ads in this range still render so the operator can see the ad
      // set exists and decide whether to sync.
      .filter((g) => q === "" || g.adItems.length > 0)
      .map((g) => ({ ...g, adItems: [...g.adItems].sort((a, b) => compare(a, b, sortKey, sortDir)) }))
      .sort((a, b) => a.adAccountName.localeCompare(b.adAccountName));
  }, [groups, search, campaignFilter, sortKey, sortDir]);

  const allIds = useMemo(() => filteredGroups.flatMap((g) => g.adItems.map((a) => a.id)), [filteredGroups]);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someSelected = allIds.some((id) => selected.has(id));

  function toggleAll() { setSelected(allSelected ? new Set() : new Set(allIds)); }
  function toggleOne(id: string) {
    setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  function bulkAction(status: "ACTIVE" | "PAUSED") {
    const ids = [...selected];
    startBulkTransition(async () => { await bulkToggleAdStatusAction(ids, status); setSelected(new Set()); });
  }

  if (filteredGroups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center text-sm text-zinc-500">
        <p>No ads match the current filters.</p>
      </div>
    );
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("desc"); }
  }

  const vis = (label: ColLabel) => !hidden.has(label);
  const visibleCount = 3 + TOGGLEABLE.filter((l) => vis(l)).length;

  return (
    <>
      <div className="flex items-center justify-end border-b border-zinc-200 bg-white px-6 py-2 dark:border-zinc-800 dark:bg-zinc-950">
        <ColumnChooser columns={[...TOGGLEABLE]} hidden={hidden} onToggle={toggleCol} />
      </div>

      <div className="overflow-auto">
        <table className="min-w-full text-xs">
          <thead className="sticky top-0 z-10 bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
            <tr>
              <th className="w-8 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
                <input type="checkbox" checked={allSelected} ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }} onChange={toggleAll} className="h-3.5 w-3.5 accent-blue-600" />
              </th>
              <th className="w-16 border-b border-zinc-200 px-3 py-2 text-left dark:border-zinc-800">On/Off</th>
              <th className="border-b border-zinc-200 px-3 py-2 text-left dark:border-zinc-800">
                <button type="button" onClick={() => toggleSort("name")} className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100">Ad name{sortKey === "name" ? <span>{sortDir === "asc" ? "↑" : "↓"}</span> : null}</button>
              </th>
              {vis("Delivery") && <th className="border-b border-zinc-200 px-3 py-2 text-left dark:border-zinc-800">Delivery</th>}
              {vis("Results") && <th className="border-b border-zinc-200 px-3 py-2 text-right dark:border-zinc-800"><button type="button" onClick={() => toggleSort("results")} className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100">Results{sortKey === "results" ? <span>{sortDir === "asc" ? "↑" : "↓"}</span> : null}</button></th>}
              {vis("Cost / result") && <th className="border-b border-zinc-200 px-3 py-2 text-right dark:border-zinc-800"><button type="button" onClick={() => toggleSort("costPerResult")} className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100">Cost / result{sortKey === "costPerResult" ? <span>{sortDir === "asc" ? "↑" : "↓"}</span> : null}</button></th>}
              {vis("Amount spent") && <th className="border-b border-zinc-200 px-3 py-2 text-right dark:border-zinc-800"><button type="button" onClick={() => toggleSort("spend")} className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100">Amount spent{sortKey === "spend" ? <span>{sortDir === "asc" ? "↑" : "↓"}</span> : null}</button></th>}
              {vis("Frequency") && <th className="border-b border-zinc-200 px-3 py-2 text-right dark:border-zinc-800">Frequency</th>}
              {vis("CTR (all)") && <th className="border-b border-zinc-200 px-3 py-2 text-right dark:border-zinc-800"><button type="button" onClick={() => toggleSort("ctr")} className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100">CTR (all){sortKey === "ctr" ? <span>{sortDir === "asc" ? "↑" : "↓"}</span> : null}</button></th>}
              {vis("Purchases") && <th className="border-b border-zinc-200 px-3 py-2 text-right dark:border-zinc-800">Purchases</th>}
              {vis("Web purchases") && <th className="border-b border-zinc-200 px-3 py-2 text-right dark:border-zinc-800">Web purchases</th>}
              {vis("Purchase ROAS") && <th className="border-b border-zinc-200 px-3 py-2 text-right dark:border-zinc-800"><button type="button" onClick={() => toggleSort("purchaseRoas")} className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100">Purchase ROAS{sortKey === "purchaseRoas" ? <span>{sortDir === "asc" ? "↑" : "↓"}</span> : null}</button></th>}
              {vis("Conv. value") && <th className="border-b border-zinc-200 px-3 py-2 text-right dark:border-zinc-800">Conv. value</th>}
              <th className="w-10 border-b border-zinc-200 dark:border-zinc-800" />
            </tr>
          </thead>
          <tbody>
            {filteredGroups.map((group) => {
              const isEmpty = group.adItems.length === 0;
              const isCollapsed =
                collapsed.has(group.adSetId) ||
                (isEmpty && !forceExpanded.has(group.adSetId));
              return (
                <AdSetSection key={group.adSetId} group={group} selected={selected} onToggle={toggleOne} vis={vis} visibleCount={visibleCount} isCollapsed={isCollapsed} onToggleCollapsed={toggleCollapsed} />
              );
            })}
          </tbody>
        </table>
      </div>

      <BulkActionBar count={selected.size} entityLabel="ad" onPause={() => bulkAction("PAUSED")} onResume={() => bulkAction("ACTIVE")} onClear={() => setSelected(new Set())} isPending={bulkPending} />
    </>
  );
}

function AdSetSection({ group, selected, onToggle, vis, visibleCount, isCollapsed, onToggleCollapsed }: {
  group: AdsByAdSet;
  selected: Set<string>;
  onToggle: (id: string) => void;
  vis: (l: ColLabel) => boolean;
  visibleCount: number;
  isCollapsed: boolean;
  onToggleCollapsed: (key: string, isEmpty: boolean) => void;
}) {
  const isEmpty = group.adItems.length === 0;
  const totals = group.adItems.reduce(
    (acc, a) => {
      acc.spend += a.spend; acc.results += a.results; acc.impressions += a.impressions; acc.clicks += a.clicks;
      if (a.purchases != null) acc.purchases = (acc.purchases ?? 0) + a.purchases;
      if (a.webPurchases != null) acc.webPurchases = (acc.webPurchases ?? 0) + a.webPurchases;
      if (a.conversionValue != null) acc.conversionValue = (acc.conversionValue ?? 0) + a.conversionValue;
      return acc;
    },
    { spend: 0, results: 0, impressions: 0, clicks: 0, purchases: null as number | null, webPurchases: null as number | null, conversionValue: null as number | null },
  );
  const cpr = totals.results > 0 ? totals.spend / totals.results : null;
  const ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : null;

  return (
    <>
      <tr className={`text-[11px] font-semibold ${isEmpty ? "bg-zinc-50 text-zinc-500 dark:bg-zinc-950 dark:text-zinc-400" : "bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"}`}>
        <td colSpan={visibleCount} className="border-b border-zinc-200 p-0 dark:border-zinc-800">
          <button
            type="button"
            onClick={() => onToggleCollapsed(group.adSetId, isEmpty)}
            aria-expanded={!isCollapsed}
            aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${group.adSetName}`}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60"
          >
            <span className="flex items-center gap-1.5">
              {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              <span>{group.adSetName}<span className="ml-1 font-normal text-zinc-500">· {group.adItems.length} ad{group.adItems.length === 1 ? "" : "s"}</span></span>
            </span>
            <span className="font-normal text-zinc-500">{group.campaignName}</span>
          </button>
        </td>
      </tr>
      {!isCollapsed && isEmpty && (
        <tr className="bg-white text-zinc-500 dark:bg-zinc-950 dark:text-zinc-400">
          <td colSpan={visibleCount} className="border-b border-zinc-200 px-3 py-3 text-xs dark:border-zinc-800">
            <span className="inline-flex items-center gap-1.5">
              <Info className="h-3.5 w-3.5" />
              No ads in this range for this ad set. Try a wider date range, or hit "Refresh from Meta" above.
            </span>
          </td>
        </tr>
      )}
      {!isCollapsed && group.adItems.map((a) => (
        <AdTableRow key={a.id} a={a} isSelected={selected.has(a.id)} onToggle={onToggle} vis={vis} />
      ))}
      {!isCollapsed && !isEmpty && (
      <tr className="bg-zinc-50 text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
        <td colSpan={vis("Delivery") ? 4 : 3} className="border-b border-zinc-200 px-3 py-1.5 text-right text-[11px] font-medium dark:border-zinc-800">Subtotal</td>
        {vis("Results") && <td className="border-b border-zinc-200 px-3 py-1.5 text-right dark:border-zinc-800">{formatNumber(totals.results)}</td>}
        {vis("Cost / result") && <td className="border-b border-zinc-200 px-3 py-1.5 text-right dark:border-zinc-800">{cpr != null ? formatMyr(cpr) : "—"}</td>}
        {vis("Amount spent") && <td className="border-b border-zinc-200 px-3 py-1.5 text-right dark:border-zinc-800">{formatMyr(totals.spend)}</td>}
        {vis("Frequency") && <td className="border-b border-zinc-200 px-3 py-1.5 text-right text-zinc-400 dark:border-zinc-800">—</td>}
        {vis("CTR (all)") && <td className="border-b border-zinc-200 px-3 py-1.5 text-right dark:border-zinc-800">{ctr != null ? `${ctr.toFixed(2)}%` : "—"}</td>}
        {vis("Purchases") && <td className="border-b border-zinc-200 px-3 py-1.5 text-right dark:border-zinc-800">{totals.purchases != null ? formatNumber(totals.purchases) : "—"}</td>}
        {vis("Web purchases") && <td className="border-b border-zinc-200 px-3 py-1.5 text-right dark:border-zinc-800">{totals.webPurchases != null ? formatNumber(totals.webPurchases) : "—"}</td>}
        {vis("Purchase ROAS") && <td className="border-b border-zinc-200 px-3 py-1.5 text-right text-zinc-400 dark:border-zinc-800">—</td>}
        {vis("Conv. value") && <td className="border-b border-zinc-200 px-3 py-1.5 text-right dark:border-zinc-800">{totals.conversionValue != null ? formatMyr(totals.conversionValue) : "—"}</td>}
        <td className="border-b border-zinc-200 px-3 py-1.5 dark:border-zinc-800" />
      </tr>
      )}
    </>
  );
}

function AdTableRow({ a, isSelected, onToggle, vis }: { a: AdManagerRow; isSelected: boolean; onToggle: (id: string) => void; vis: (l: ColLabel) => boolean }) {
  const isActive = a.effectiveStatus === "ACTIVE" || a.status === "ACTIVE";
  const deliveryLabel = (() => {
    if (!a.effectiveStatus || a.effectiveStatus === "ACTIVE") return null;
    const map: Record<string, string> = {
      PAUSED: "Paused", ADSET_PAUSED: "Ad set off", CAMPAIGN_PAUSED: "Campaign off",
      PENDING_REVIEW: "In review", DISAPPROVED: "Rejected", WITH_ISSUES: "With issues",
    };
    return map[a.effectiveStatus] ?? a.effectiveStatus.toLowerCase().replace(/_/g, " ");
  })();

  return (
    <tr className={`border-b border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-900/50 ${isSelected ? "bg-blue-50/60 dark:bg-blue-950/20" : ""}`}>
      <td className="px-3 py-2"><input type="checkbox" checked={isSelected} onChange={() => onToggle(a.id)} className="h-3.5 w-3.5 accent-blue-600" /></td>
      <td className="px-3 py-2"><AdStatusToggle adId={a.id} isActive={isActive} /></td>
      <td className="max-w-[260px] px-3 py-2"><span className="block truncate font-medium text-zinc-900 dark:text-zinc-100" title={a.name}>{a.name}</span></td>
      {vis("Delivery") && (
        <td className="px-3 py-2">
          {deliveryLabel
            ? <span className="rounded-sm bg-amber-100 px-1 py-0.5 text-[10px] text-amber-800 dark:bg-amber-950 dark:text-amber-300">{deliveryLabel}</span>
            : isActive
              ? <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
              : <span className="inline-block h-2 w-2 rounded-full bg-zinc-300" />
          }
        </td>
      )}
      {vis("Results") && <td className="px-3 py-2 text-right">{formatNumber(a.results)}</td>}
      {vis("Cost / result") && <td className="px-3 py-2 text-right">{a.costPerResult != null ? formatMyr(a.costPerResult) : "—"}</td>}
      {vis("Amount spent") && <td className="px-3 py-2 text-right font-medium">{formatMyr(a.spend)}</td>}
      {vis("Frequency") && <td className="px-3 py-2 text-right text-zinc-400">—</td>}
      {vis("CTR (all)") && <td className="px-3 py-2 text-right">{a.ctr != null ? `${a.ctr.toFixed(2)}%` : "—"}</td>}
      {vis("Purchases") && <td className="px-3 py-2 text-right">{a.purchases != null ? formatNumber(a.purchases) : "—"}</td>}
      {vis("Web purchases") && <td className="px-3 py-2 text-right">{a.webPurchases != null ? formatNumber(a.webPurchases) : "—"}</td>}
      {vis("Purchase ROAS") && <td className="px-3 py-2 text-right">{a.purchaseRoas != null ? a.purchaseRoas.toFixed(2) : "—"}</td>}
      {vis("Conv. value") && <td className="px-3 py-2 text-right">{a.conversionValue != null ? formatMyr(a.conversionValue) : "—"}</td>}
      <td className="px-3 py-2">
        <div className="flex items-center gap-1">
          <Link href={`https://www.facebook.com/adsmanager/manage/ads?act=${a.metaAccountId}&selected_ad_ids=${a.metaAdId}`} target="_blank" rel="noopener noreferrer" title="Open in Meta Ads Manager" className="inline-flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800">
            <ExternalLink className="h-3 w-3" />
          </Link>
          <button type="button" disabled title="Duplicate (coming soon)" className="inline-flex h-6 w-6 items-center justify-center rounded text-zinc-300 dark:text-zinc-700">
            <Copy className="h-3 w-3" />
          </button>
        </div>
      </td>
    </tr>
  );
}

function compare(a: AdManagerRow, b: AdManagerRow, key: SortKey, dir: "asc" | "desc"): number {
  const sign = dir === "asc" ? 1 : -1;
  const av = pick(a, key); const bv = pick(b, key);
  if (av == null && bv == null) return 0; if (av == null) return 1; if (bv == null) return -1;
  if (typeof av === "string" && typeof bv === "string") return sign * av.localeCompare(bv);
  return sign * ((av as number) - (bv as number));
}

function pick(a: AdManagerRow, key: SortKey): string | number | null {
  switch (key) {
    case "name": return a.name; case "results": return a.results;
    case "costPerResult": return a.costPerResult; case "spend": return a.spend;
    case "ctr": return a.ctr; case "purchaseRoas": return a.purchaseRoas;
  }
}
