"use client";

import { useMemo, useState, useTransition, useCallback, useEffect } from "react";
import Link from "next/link";
import { ExternalLink, ChevronDown, ChevronRight, ArrowLeftRight, Info } from "lucide-react";
import { AdSetStatusToggle } from "./AdSetStatusToggle";
import { BulkActionBar } from "./BulkActionBar";
import { ColumnChooser } from "./ColumnChooser";
import { BudgetCell } from "./BudgetCell";
import { SyncAdSetsDialog } from "./SyncAdSetsDialog";
import { formatMyr, formatNumber } from "@/lib/utils";
import { bulkToggleAdSetStatusAction, updateAdSetBudgetAction } from "./actions";
import type { AdSetsByCampaign, AdSetManagerRow, CampaignRow, CampaignsByAccount } from "@/lib/db/queries/manager";

type SortKey = "name" | "budget" | "results" | "costPerResult" | "spend" | "ctr" | "purchaseRoas";

const TOGGLEABLE = [
  "Budget",
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

const STORAGE_KEY = "adsets_hidden_cols";
const COLLAPSED_KEY = "adsets.collapsedCampaigns.v1";

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

/** Derive a minimal CampaignRow from an ad set row (for passing to SyncAdSetsDialog). */
function adSetToCampaignRow(s: AdSetManagerRow): CampaignRow {
  return {
    id: s.campaignId,
    metaCampaignId: s.metaCampaignId,
    name: s.campaignName,
    objective: null,
    status: s.status,
    effectiveStatus: null,
    dailyBudget: null,
    lifetimeBudget: null,
    adAccountId: s.adAccountId,
    adAccountName: s.adAccountName,
    autoPauseExempt: false,
    autoPauseExemptReason: null,
    spend: 0, results: 0, costPerResult: null, ctr: null, purchaseRoas: null,
    purchases: null, webPurchases: null, conversionValue: null, impressions: 0, clicks: 0,
  };
}

/** Convert ad-sets-by-campaign groups into the campaign-by-account shape SyncAdSetsDialog expects. */
function deriveCampaignsByAccount(adSetGroups: AdSetsByCampaign[]): CampaignsByAccount[] {
  const accountMap = new Map<string, CampaignsByAccount>();
  for (const g of adSetGroups) {
    if (!accountMap.has(g.adAccountName)) {
      accountMap.set(g.adAccountName, {
        adAccountId: g.adSets[0]?.adAccountId ?? "",
        adAccountName: g.adAccountName,
        metaAccountId: g.metaAccountId,
        campaigns: [],
      });
    }
    const account = accountMap.get(g.adAccountName)!;
    if (!account.campaigns.find((c) => c.id === g.campaignId)) {
      account.campaigns.push({
        id: g.campaignId,
        metaCampaignId: g.metaCampaignId,
        name: g.campaignName,
        objective: null, status: "ACTIVE", effectiveStatus: null,
        dailyBudget: null, lifetimeBudget: null,
        adAccountId: g.adSets[0]?.adAccountId ?? "",
        adAccountName: g.adAccountName,
        autoPauseExempt: false,
        autoPauseExemptReason: null,
        spend: 0, results: 0, costPerResult: null, ctr: null, purchaseRoas: null,
        purchases: null, webPurchases: null, conversionValue: null, impressions: 0, clicks: 0,
      });
    }
  }
  return Array.from(accountMap.values());
}

export function AdSetsTable({
  groups,
  search,
  campaignFilter,
}: {
  groups: AdSetsByCampaign[];
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
  const [syncAdSet, setSyncAdSet] = useState<AdSetManagerRow | null>(null);
  const campaignsByAccount = useMemo(() => deriveCampaignsByAccount(groups), [groups]);

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
        adSets: q ? g.adSets.filter((s) => s.name.toLowerCase().includes(q)) : g.adSets,
      }))
      // Only drop empty campaign groups while searching — at rest, campaigns
      // with zero ad sets in this range still render so the operator can see
      // that the campaign exists and decide whether to sync.
      .filter((g) => q === "" || g.adSets.length > 0)
      .map((g) => ({ ...g, adSets: [...g.adSets].sort((a, b) => compare(a, b, sortKey, sortDir)) }))
      .sort((a, b) => a.adAccountName.localeCompare(b.adAccountName));
  }, [groups, search, campaignFilter, sortKey, sortDir]);

  const allIds = useMemo(() => filteredGroups.flatMap((g) => g.adSets.map((s) => s.id)), [filteredGroups]);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someSelected = allIds.some((id) => selected.has(id));

  function toggleAll() { setSelected(allSelected ? new Set() : new Set(allIds)); }
  function toggleOne(id: string) {
    setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  function bulkAction(status: "ACTIVE" | "PAUSED") {
    const ids = [...selected];
    startBulkTransition(async () => { await bulkToggleAdSetStatusAction(ids, status); setSelected(new Set()); });
  }

  if (filteredGroups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center text-sm text-zinc-500">
        <p>No ad sets match the current filters.</p>
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
                <button type="button" onClick={() => toggleSort("name")} className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100">
                  Ad set{sortKey === "name" ? <span>{sortDir === "asc" ? "↑" : "↓"}</span> : null}
                </button>
              </th>
              {vis("Budget") && <th className="border-b border-zinc-200 px-3 py-2 text-right dark:border-zinc-800"><button type="button" onClick={() => toggleSort("budget")} className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100">Budget{sortKey === "budget" ? <span>{sortDir === "asc" ? "↑" : "↓"}</span> : null}</button></th>}
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
              const isEmpty = group.adSets.length === 0;
              const isCollapsed =
                collapsed.has(group.campaignId) ||
                (isEmpty && !forceExpanded.has(group.campaignId));
              return (
                <CampaignSection key={group.campaignId} group={group} selected={selected} onToggle={toggleOne} vis={vis} visibleCount={visibleCount} isCollapsed={isCollapsed} onToggleCollapsed={toggleCollapsed} onSync={setSyncAdSet} />
              );
            })}
          </tbody>
        </table>
      </div>

      <BulkActionBar count={selected.size} entityLabel="ad set" onPause={() => bulkAction("PAUSED")} onResume={() => bulkAction("ACTIVE")} onClear={() => setSelected(new Set())} isPending={bulkPending} />

      {syncAdSet && (
        <SyncAdSetsDialog
          campaign={adSetToCampaignRow(syncAdSet)}
          groups={campaignsByAccount}
          initialSrcAdSetMetaId={syncAdSet.metaAdSetId}
          onClose={() => setSyncAdSet(null)}
        />
      )}
    </>
  );
}

function CampaignSection({ group, selected, onToggle, vis, visibleCount, isCollapsed, onToggleCollapsed, onSync }: {
  group: AdSetsByCampaign;
  selected: Set<string>;
  onToggle: (id: string) => void;
  vis: (label: ColLabel) => boolean;
  visibleCount: number;
  isCollapsed: boolean;
  onToggleCollapsed: (key: string, isEmpty: boolean) => void;
  onSync: (s: AdSetManagerRow) => void;
}) {
  const isEmpty = group.adSets.length === 0;
  const totals = group.adSets.reduce(
    (acc, s) => {
      acc.spend += s.spend; acc.results += s.results; acc.impressions += s.impressions; acc.clicks += s.clicks;
      if (s.purchases != null) acc.purchases = (acc.purchases ?? 0) + s.purchases;
      if (s.webPurchases != null) acc.webPurchases = (acc.webPurchases ?? 0) + s.webPurchases;
      if (s.conversionValue != null) acc.conversionValue = (acc.conversionValue ?? 0) + s.conversionValue;
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
            onClick={() => onToggleCollapsed(group.campaignId, isEmpty)}
            aria-expanded={!isCollapsed}
            aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${group.campaignName}`}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60"
          >
            <span className="flex items-center gap-1.5">
              {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              <span>{group.campaignName}<span className="ml-1 font-normal text-zinc-500">· {group.adSets.length} ad set{group.adSets.length === 1 ? "" : "s"}</span></span>
            </span>
            <span className="font-normal text-zinc-500">{group.adAccountName}</span>
          </button>
        </td>
      </tr>
      {!isCollapsed && isEmpty && (
        <tr className="bg-white text-zinc-500 dark:bg-zinc-950 dark:text-zinc-400">
          <td colSpan={visibleCount} className="border-b border-zinc-200 px-3 py-3 text-xs dark:border-zinc-800">
            <span className="inline-flex items-center gap-1.5">
              <Info className="h-3.5 w-3.5" />
              No ad sets in this range for this campaign. Try a wider date range, or hit "Refresh from Meta" above.
            </span>
          </td>
        </tr>
      )}
      {!isCollapsed && group.adSets.map((s) => (
        <AdSetTableRow key={s.id} s={s} isSelected={selected.has(s.id)} onToggle={onToggle} vis={vis} onSync={onSync} />
      ))}
      {!isCollapsed && !isEmpty && (
      <tr className="bg-zinc-50 text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
        <td colSpan={vis("Budget") ? 4 : 3} className="border-b border-zinc-200 px-3 py-1.5 text-right text-[11px] font-medium dark:border-zinc-800">Subtotal</td>
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

function AdSetTableRow({ s, isSelected, onToggle, vis, onSync }: { s: AdSetManagerRow; isSelected: boolean; onToggle: (id: string) => void; vis: (l: ColLabel) => boolean; onSync: (s: AdSetManagerRow) => void }) {
  const isActive = s.effectiveStatus === "ACTIVE" || s.status === "ACTIVE";
  const budgetCents = s.dailyBudget ?? s.lifetimeBudget;
  const budgetKind = s.dailyBudget != null ? "daily" : s.lifetimeBudget != null ? "lifetime" : null;

  return (
    <tr className={`border-b border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-900/50 ${isSelected ? "bg-blue-50/60 dark:bg-blue-950/20" : ""}`}>
      <td className="px-3 py-2"><input type="checkbox" checked={isSelected} onChange={() => onToggle(s.id)} className="h-3.5 w-3.5 accent-blue-600" /></td>
      <td className="px-3 py-2"><AdSetStatusToggle adSetId={s.id} isActive={isActive} /></td>
      <td className="px-3 py-2">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium text-zinc-900 dark:text-zinc-100">{s.name}</span>
          {s.effectiveStatus && s.effectiveStatus !== "ACTIVE" && (
            <span className="rounded-sm bg-amber-100 px-1 py-0.5 text-[10px] text-amber-800 dark:bg-amber-950 dark:text-amber-300">{s.effectiveStatus.toLowerCase().replace(/_/g, " ")}</span>
          )}
        </div>
      </td>
      {vis("Budget") && <td className="px-3 py-2 text-right"><BudgetCell entityId={s.id} budgetCents={budgetCents} budgetKind={budgetKind} onSave={updateAdSetBudgetAction} /></td>}
      {vis("Results") && <td className="px-3 py-2 text-right">{formatNumber(s.results)}</td>}
      {vis("Cost / result") && <td className="px-3 py-2 text-right">{s.costPerResult != null ? formatMyr(s.costPerResult) : "—"}</td>}
      {vis("Amount spent") && <td className="px-3 py-2 text-right font-medium">{formatMyr(s.spend)}</td>}
      {vis("Frequency") && <td className="px-3 py-2 text-right text-zinc-400">—</td>}
      {vis("CTR (all)") && <td className="px-3 py-2 text-right">{s.ctr != null ? `${s.ctr.toFixed(2)}%` : "—"}</td>}
      {vis("Purchases") && <td className="px-3 py-2 text-right">{s.purchases != null ? formatNumber(s.purchases) : "—"}</td>}
      {vis("Web purchases") && <td className="px-3 py-2 text-right">{s.webPurchases != null ? formatNumber(s.webPurchases) : "—"}</td>}
      {vis("Purchase ROAS") && <td className="px-3 py-2 text-right">{s.purchaseRoas != null ? s.purchaseRoas.toFixed(2) : "—"}</td>}
      {vis("Conv. value") && <td className="px-3 py-2 text-right">{s.conversionValue != null ? formatMyr(s.conversionValue) : "—"}</td>}
      <td className="px-3 py-2">
        <div className="flex items-center gap-1">
          <Link href={`https://www.facebook.com/adsmanager/manage/adsets?act=${s.metaAccountId}&selected_adset_ids=${s.metaAdSetId}`} target="_blank" rel="noopener noreferrer" title="Open in Meta Ads Manager" className="inline-flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800">
            <ExternalLink className="h-3 w-3" />
          </Link>
          <button
            type="button"
            onClick={() => onSync(s)}
            title="Sync / clone this ad set"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"
          >
            <ArrowLeftRight className="h-3 w-3" />
          </button>
        </div>
      </td>
    </tr>
  );
}

function compare(a: AdSetManagerRow, b: AdSetManagerRow, key: SortKey, dir: "asc" | "desc"): number {
  const sign = dir === "asc" ? 1 : -1;
  const av = pick(a, key); const bv = pick(b, key);
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  if (typeof av === "string" && typeof bv === "string") return sign * av.localeCompare(bv);
  return sign * ((av as number) - (bv as number));
}

function pick(s: AdSetManagerRow, key: SortKey): string | number | null {
  switch (key) {
    case "name": return s.name;
    case "budget": return s.dailyBudget ?? s.lifetimeBudget ?? null;
    case "results": return s.results;
    case "costPerResult": return s.costPerResult;
    case "spend": return s.spend;
    case "ctr": return s.ctr;
    case "purchaseRoas": return s.purchaseRoas;
  }
}
