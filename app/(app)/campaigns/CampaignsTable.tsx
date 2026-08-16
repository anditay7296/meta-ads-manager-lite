"use client";

import { useMemo, useState, useTransition, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Copy, ExternalLink, ArrowLeftRight, ChevronDown, ChevronRight, Info, RefreshCw } from "lucide-react";
import { CampaignStatusToggle } from "./CampaignStatusToggle";
import { AutoPauseExemptToggle } from "./AutoPauseExemptToggle";
import { BulkActionBar } from "./BulkActionBar";
import { ColumnChooser } from "./ColumnChooser";
import { BudgetCell } from "./BudgetCell";
import { SyncAdSetsDialog } from "./SyncAdSetsDialog";
import { CloneCampaignDialog } from "./CloneCampaignDialog";
import { formatMyr, formatNumber } from "@/lib/utils";
import {
  bulkToggleCampaignStatusAction,
  updateCampaignBudgetAction,
  refreshCampaignsForSyncAction,
} from "./actions";
import type { CampaignsByAccount, CampaignRow } from "@/lib/db/queries/manager";

type SortKey =
  | "name"
  | "budget"
  | "results"
  | "costPerResult"
  | "spend"
  | "ctr"
  | "purchaseRoas";

// Toggleable columns (labels used as keys). On/Off and action buttons are always shown.
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

const STORAGE_KEY = "campaigns_hidden_cols";
const COLLAPSED_KEY = "campaigns.collapsedAccounts.v1";

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

function loadHidden(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function saveHidden(s: Set<string>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...s]));
}

function buildSyncableNames(groups: CampaignsByAccount[]): Set<string> {
  const counts = new Map<string, number>();
  for (const g of groups) {
    for (const c of g.campaigns) {
      counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
    }
  }
  return new Set([...counts.entries()].filter(([, n]) => n >= 2).map(([name]) => name));
}

export function CampaignsTable({
  groups,
  search,
}: {
  groups: CampaignsByAccount[];
  search: string;
}) {
  const router = useRouter();
  const [sortKey, setSortKey] = useState<SortKey>("spend");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [syncCampaign, setSyncCampaign] = useState<CampaignRow | null>(null);
  const [cloneCampaign, setCloneCampaign] = useState<CampaignRow | null>(null);
  const [refreshingSyncFor, setRefreshingSyncFor] = useState<string | null>(null);
  const [pendingSyncForId, setPendingSyncForId] = useState<string | null>(null);
  const [syncRefreshMessage, setSyncRefreshMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [forceExpanded, setForceExpanded] = useState<Set<string>>(new Set());
  const [bulkPending, startBulkTransition] = useTransition();
  const syncableNames = useMemo(() => buildSyncableNames(groups), [groups]);

  // Load persisted column visibility + collapsed groups on mount.
  useEffect(() => { setHidden(loadHidden()); setCollapsed(loadCollapsed()); }, []);

  const toggleCollapsed = useCallback((key: string, isEmpty: boolean) => {
    setCollapsed((prevCollapsed) => {
      const wasCollapsed =
        prevCollapsed.has(key) || (isEmpty && !forceExpanded.has(key));
      if (wasCollapsed) {
        // Expand: drop explicit collapse if set; otherwise mark as force-expanded
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
      // Collapse: persist explicit collapse, clear any in-memory force-expand
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
      .map((g) => ({
        ...g,
        campaigns: q
          ? g.campaigns.filter((c) => c.name.toLowerCase().includes(q))
          : g.campaigns,
      }))
      // Only drop empty groups while searching — at rest, allocated accounts
      // with zero matching campaigns still render so the operator can see
      // every ad account assigned to the project.
      .filter((g) => q === "" || g.campaigns.length > 0)
      .map((g) => ({
        ...g,
        campaigns: [...g.campaigns].sort((a, b) => compare(a, b, sortKey, sortDir)),
      }));
  }, [groups, search, sortKey, sortDir]);

  const allIds = useMemo(
    () => filteredGroups.flatMap((g) => g.campaigns.map((c) => c.id)),
    [filteredGroups],
  );
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someSelected = allIds.some((id) => selected.has(id));

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(allIds));
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function bulkAction(status: "ACTIVE" | "PAUSED") {
    const ids = [...selected];
    startBulkTransition(async () => {
      await bulkToggleCampaignStatusAction(ids, status);
      setSelected(new Set());
    });
  }

  // Click handler for the Sync ad sets row button. If the campaign name
  // already appears in 2+ ad accounts (canSync=true), open the dialog
  // directly. Otherwise, run a focused Meta refresh first — the same-
  // named campaign in the other account may have been created after our
  // last periodic sync.
  const handleSyncClick = useCallback(
    async (c: CampaignRow, canSync: boolean) => {
      setSyncRefreshMessage(null);
      if (canSync) {
        setSyncCampaign(c);
        return;
      }
      setRefreshingSyncFor(c.id);
      try {
        const r = await refreshCampaignsForSyncAction(c.name);
        if (!r.ok) {
          setSyncRefreshMessage(r.message ?? "Refresh failed");
          return;
        }
        if (r.matchFound) {
          setPendingSyncForId(c.id);
          router.refresh();
        } else {
          setSyncRefreshMessage(r.message ?? "No matching campaign found");
        }
      } finally {
        setRefreshingSyncFor((current) => (current === c.id ? null : current));
      }
    },
    [router],
  );

  // When refresh discovered a new match, the page re-renders with
  // updated `groups` and `syncableNames`. Open the dialog on the
  // first render where the predicate flipped to true.
  useEffect(() => {
    if (!pendingSyncForId) return;
    const allCampaigns = groups.flatMap((g) => g.campaigns);
    const c = allCampaigns.find((x) => x.id === pendingSyncForId);
    if (!c) return;
    // Recompute name → count in case `syncableNames` hasn't been rebuilt
    // yet by the parent memo (defensive).
    const counts = new Map<string, number>();
    for (const g of groups) for (const x of g.campaigns) counts.set(x.name, (counts.get(x.name) ?? 0) + 1);
    if ((counts.get(c.name) ?? 0) >= 2) {
      setSyncCampaign(c);
      setPendingSyncForId(null);
    }
  }, [groups, pendingSyncForId]);

  // Auto-dismiss the refresh-failed banner after a few seconds so it
  // doesn't linger.
  useEffect(() => {
    if (!syncRefreshMessage) return;
    const id = setTimeout(() => setSyncRefreshMessage(null), 6000);
    return () => clearTimeout(id);
  }, [syncRefreshMessage]);

  if (filteredGroups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center text-sm text-zinc-500">
        <p>No campaigns match the current filters.</p>
      </div>
    );
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("desc"); }
  }

  // Build visible column spec (always-on + toggleable).
  const vis = (label: ColLabel) => !hidden.has(label);
  // checkbox + on/off + name + auto-pause + visible toggleable cols + actions
  const visibleCount = 4 + TOGGLEABLE.filter((l) => vis(l)).length;

  return (
    <>
      {syncCampaign && (
        <SyncAdSetsDialog
          campaign={syncCampaign}
          groups={groups}
          onClose={() => setSyncCampaign(null)}
        />
      )}

      {cloneCampaign && (
        <CloneCampaignDialog
          campaign={cloneCampaign}
          groups={groups}
          onClose={() => setCloneCampaign(null)}
        />
      )}

      {syncRefreshMessage && (
        <div className="border-b border-amber-200 bg-amber-50 px-6 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
          {syncRefreshMessage}
        </div>
      )}

      {/* Column chooser toolbar */}
      <div className="flex items-center justify-end border-b border-zinc-200 bg-white px-6 py-2 dark:border-zinc-800 dark:bg-zinc-950">
        <ColumnChooser
          columns={[...TOGGLEABLE]}
          hidden={hidden}
          onToggle={toggleCol}
        />
      </div>

      <div className="overflow-auto">
        <table className="min-w-full text-xs">
          <thead className="sticky top-0 z-10 bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
            <tr>
              <th className="w-8 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                  onChange={toggleAll}
                  className="h-3.5 w-3.5 accent-blue-600"
                />
              </th>
              <th className="w-16 border-b border-zinc-200 px-3 py-2 text-left dark:border-zinc-800">On/Off</th>
              <th className="border-b border-zinc-200 px-3 py-2 text-left dark:border-zinc-800">
                <button type="button" onClick={() => toggleSort("name")} className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100">
                  Campaign{sortKey === "name" ? <span>{sortDir === "asc" ? "↑" : "↓"}</span> : null}
                </button>
              </th>
              <th className="w-28 border-b border-zinc-200 px-3 py-2 text-left dark:border-zinc-800" title="When 'Exempt', this app's rule engine skips the campaign. The scheduled runs live in the main AI Ads Agent app — set it there too">
                Auto-pause
              </th>
              {vis("Budget") && (
                <th className="border-b border-zinc-200 px-3 py-2 text-right dark:border-zinc-800">
                  <button type="button" onClick={() => toggleSort("budget")} className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100">
                    Budget{sortKey === "budget" ? <span>{sortDir === "asc" ? "↑" : "↓"}</span> : null}
                  </button>
                </th>
              )}
              {vis("Results") && (
                <th className="border-b border-zinc-200 px-3 py-2 text-right dark:border-zinc-800">
                  <button type="button" onClick={() => toggleSort("results")} className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100">
                    Results{sortKey === "results" ? <span>{sortDir === "asc" ? "↑" : "↓"}</span> : null}
                  </button>
                </th>
              )}
              {vis("Cost / result") && (
                <th className="border-b border-zinc-200 px-3 py-2 text-right dark:border-zinc-800">
                  <button type="button" onClick={() => toggleSort("costPerResult")} className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100">
                    Cost / result{sortKey === "costPerResult" ? <span>{sortDir === "asc" ? "↑" : "↓"}</span> : null}
                  </button>
                </th>
              )}
              {vis("Amount spent") && (
                <th className="border-b border-zinc-200 px-3 py-2 text-right dark:border-zinc-800">
                  <button type="button" onClick={() => toggleSort("spend")} className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100">
                    Amount spent{sortKey === "spend" ? <span>{sortDir === "asc" ? "↑" : "↓"}</span> : null}
                  </button>
                </th>
              )}
              {vis("Frequency") && <th className="border-b border-zinc-200 px-3 py-2 text-right dark:border-zinc-800">Frequency</th>}
              {vis("CTR (all)") && (
                <th className="border-b border-zinc-200 px-3 py-2 text-right dark:border-zinc-800">
                  <button type="button" onClick={() => toggleSort("ctr")} className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100">
                    CTR (all){sortKey === "ctr" ? <span>{sortDir === "asc" ? "↑" : "↓"}</span> : null}
                  </button>
                </th>
              )}
              {vis("Purchases") && <th className="border-b border-zinc-200 px-3 py-2 text-right dark:border-zinc-800">Purchases</th>}
              {vis("Web purchases") && <th className="border-b border-zinc-200 px-3 py-2 text-right dark:border-zinc-800">Web purchases</th>}
              {vis("Purchase ROAS") && (
                <th className="border-b border-zinc-200 px-3 py-2 text-right dark:border-zinc-800">
                  <button type="button" onClick={() => toggleSort("purchaseRoas")} className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100">
                    Purchase ROAS{sortKey === "purchaseRoas" ? <span>{sortDir === "asc" ? "↑" : "↓"}</span> : null}
                  </button>
                </th>
              )}
              {vis("Conv. value") && <th className="border-b border-zinc-200 px-3 py-2 text-right dark:border-zinc-800">Conv. value</th>}
              <th className="w-10 border-b border-zinc-200 dark:border-zinc-800" />
            </tr>
          </thead>
          <tbody>
            {filteredGroups.map((group) => {
              const isEmpty = group.campaigns.length === 0;
              const isCollapsed =
                collapsed.has(group.adAccountId) ||
                (isEmpty && !forceExpanded.has(group.adAccountId));
              return (
                <AccountSection
                  key={group.adAccountId}
                  group={group}
                  syncableNames={syncableNames}
                  onSyncClick={handleSyncClick}
                  onCloneClick={(c) => setCloneCampaign(c)}
                  refreshingSyncFor={refreshingSyncFor}
                  selected={selected}
                  onToggle={toggleOne}
                  vis={vis}
                  visibleCount={visibleCount}
                  isCollapsed={isCollapsed}
                  onToggleCollapsed={toggleCollapsed}
                />
              );
            })}
          </tbody>
        </table>
      </div>

      <BulkActionBar
        count={selected.size}
        entityLabel="campaign"
        onPause={() => bulkAction("PAUSED")}
        onResume={() => bulkAction("ACTIVE")}
        onClear={() => setSelected(new Set())}
        isPending={bulkPending}
      />
    </>
  );
}

function AccountSection({
  group,
  syncableNames,
  onSyncClick,
  onCloneClick,
  refreshingSyncFor,
  selected,
  onToggle,
  vis,
  visibleCount,
  isCollapsed,
  onToggleCollapsed,
}: {
  group: CampaignsByAccount;
  syncableNames: Set<string>;
  onSyncClick: (c: CampaignRow, canSync: boolean) => void;
  onCloneClick: (c: CampaignRow) => void;
  refreshingSyncFor: string | null;
  selected: Set<string>;
  onToggle: (id: string) => void;
  vis: (label: ColLabel) => boolean;
  visibleCount: number;
  isCollapsed: boolean;
  onToggleCollapsed: (key: string, isEmpty: boolean) => void;
}) {
  const isEmpty = group.campaigns.length === 0;
  const totals = group.campaigns.reduce(
    (acc, c) => {
      acc.spend += c.spend;
      acc.results += c.results;
      acc.impressions += c.impressions;
      acc.clicks += c.clicks;
      if (c.purchases != null) acc.purchases = (acc.purchases ?? 0) + c.purchases;
      if (c.webPurchases != null) acc.webPurchases = (acc.webPurchases ?? 0) + c.webPurchases;
      if (c.conversionValue != null) acc.conversionValue = (acc.conversionValue ?? 0) + c.conversionValue;
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
            onClick={() => onToggleCollapsed(group.adAccountId, isEmpty)}
            aria-expanded={!isCollapsed}
            aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${group.adAccountName}`}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60"
          >
            <span className="flex items-center gap-1.5">
              {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              <span>
                {group.adAccountName}
                <span className="ml-1 font-normal text-zinc-500">
                  · {group.campaigns.length} campaign{group.campaigns.length === 1 ? "" : "s"}
                </span>
              </span>
            </span>
            <span className="font-normal text-zinc-500">act_{group.metaAccountId}</span>
          </button>
        </td>
      </tr>
      {!isCollapsed && isEmpty && (
        <tr className="bg-white text-zinc-500 dark:bg-zinc-950 dark:text-zinc-400">
          <td colSpan={visibleCount} className="border-b border-zinc-200 px-3 py-3 text-xs dark:border-zinc-800">
            <span className="inline-flex items-center gap-1.5">
              <Info className="h-3.5 w-3.5" />
              No campaigns in this range. Try toggling <span className="font-medium">Active only</span> off, or hit &quot;Refresh from Meta&quot; above.
            </span>
          </td>
        </tr>
      )}
      {!isCollapsed && group.campaigns.map((c) => (
        <CampaignTableRow
          key={c.id}
          c={c}
          canSync={syncableNames.has(c.name)}
          onSyncClick={onSyncClick}
          onCloneClick={onCloneClick}
          isRefreshing={refreshingSyncFor === c.id}
          isSelected={selected.has(c.id)}
          onToggle={onToggle}
          vis={vis}
        />
      ))}
      {!isCollapsed && !isEmpty && (
      <tr className="bg-zinc-50 text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
        <td colSpan={vis("Budget") ? 5 : 4} className="border-b border-zinc-200 px-3 py-1.5 text-right text-[11px] font-medium dark:border-zinc-800">Subtotal</td>
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

function CampaignTableRow({
  c,
  canSync,
  onSyncClick,
  onCloneClick,
  isRefreshing,
  isSelected,
  onToggle,
  vis,
}: {
  c: CampaignRow;
  canSync: boolean;
  onSyncClick: (c: CampaignRow, canSync: boolean) => void;
  onCloneClick: (c: CampaignRow) => void;
  isRefreshing: boolean;
  isSelected: boolean;
  onToggle: (id: string) => void;
  vis: (label: ColLabel) => boolean;
}) {
  const isActive = c.effectiveStatus === "ACTIVE" || c.status === "ACTIVE";
  const budgetCents = c.dailyBudget ?? c.lifetimeBudget;
  const budgetKind = c.dailyBudget != null ? "daily" : c.lifetimeBudget != null ? "lifetime" : null;
  const sp = useSearchParams();
  const range = sp.get("range") ?? "last_7d";
  const adsetsHref =
    `/campaigns/adsets?campaign=${encodeURIComponent(c.name)}` +
    `&ad_account=${encodeURIComponent(c.adAccountName)}` +
    `&range=${range}`;

  return (
    <tr className={`border-b border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-900/50 ${isSelected ? "bg-blue-50/60 dark:bg-blue-950/20" : ""}`}>
      <td className="px-3 py-2">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggle(c.id)}
          className="h-3.5 w-3.5 accent-blue-600"
        />
      </td>
      <td className="px-3 py-2">
        <CampaignStatusToggle campaignId={c.id} isActive={isActive} />
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-col gap-0.5">
          <Link
            href={adsetsHref}
            className="font-medium text-zinc-900 hover:text-blue-600 hover:underline dark:text-zinc-100 dark:hover:text-blue-400"
            title="View ad sets in this campaign"
          >
            {c.name}
          </Link>
          <span className="text-[10px] text-zinc-500">
            {c.objective ?? "—"}
            {c.effectiveStatus && c.effectiveStatus !== "ACTIVE" ? (
              <span className="ml-2 rounded-sm bg-amber-100 px-1 py-0.5 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                {c.effectiveStatus.toLowerCase()}
              </span>
            ) : null}
          </span>
        </div>
      </td>
      <td className="px-3 py-2">
        <AutoPauseExemptToggle
          campaignId={c.id}
          isExempt={c.autoPauseExempt}
          currentReason={c.autoPauseExemptReason}
        />
      </td>
      {vis("Budget") && (
        <td className="px-3 py-2 text-right">
          <BudgetCell
            entityId={c.id}
            budgetCents={budgetCents}
            budgetKind={budgetKind}
            onSave={updateCampaignBudgetAction}
          />
        </td>
      )}
      {vis("Results") && <td className="px-3 py-2 text-right">{formatNumber(c.results)}</td>}
      {vis("Cost / result") && <td className="px-3 py-2 text-right">{c.costPerResult != null ? formatMyr(c.costPerResult) : "—"}</td>}
      {vis("Amount spent") && <td className="px-3 py-2 text-right font-medium">{formatMyr(c.spend)}</td>}
      {vis("Frequency") && <td className="px-3 py-2 text-right text-zinc-400">—</td>}
      {vis("CTR (all)") && <td className="px-3 py-2 text-right">{c.ctr != null ? `${c.ctr.toFixed(2)}%` : "—"}</td>}
      {vis("Purchases") && <td className="px-3 py-2 text-right">{c.purchases != null ? formatNumber(c.purchases) : "—"}</td>}
      {vis("Web purchases") && <td className="px-3 py-2 text-right">{c.webPurchases != null ? formatNumber(c.webPurchases) : "—"}</td>}
      {vis("Purchase ROAS") && <td className="px-3 py-2 text-right">{c.purchaseRoas != null ? c.purchaseRoas.toFixed(2) : "—"}</td>}
      {vis("Conv. value") && <td className="px-3 py-2 text-right">{c.conversionValue != null ? formatMyr(c.conversionValue) : "—"}</td>}
      <td className="px-3 py-2">
        <div className="flex items-center gap-1">
          <Link
            href={`https://www.facebook.com/adsmanager/manage/campaigns?act=${c.adAccountId}&selected_campaign_ids=${c.metaCampaignId}`}
            target="_blank"
            rel="noopener noreferrer"
            title="Open in Meta Ads Manager"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"
          >
            <ExternalLink className="h-3 w-3" />
          </Link>
          <button
            type="button"
            disabled={isRefreshing}
            title={
              isRefreshing
                ? "Refreshing from Meta…"
                : canSync
                  ? "Sync ad sets between accounts"
                  : "Refresh from Meta to look for a matching campaign in another account"
            }
            onClick={() => onSyncClick(c, canSync)}
            className={
              canSync
                ? "inline-flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-50 dark:hover:bg-zinc-800"
                : "inline-flex h-6 w-6 items-center justify-center rounded text-zinc-300 hover:bg-zinc-100 hover:text-zinc-500 disabled:opacity-50 dark:text-zinc-700 dark:hover:bg-zinc-800"
            }
          >
            {isRefreshing ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : (
              <ArrowLeftRight className="h-3 w-3" />
            )}
          </button>
          <button
            type="button"
            title="Clone campaign → another account"
            onClick={() => onCloneClick(c)}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"
          >
            <Copy className="h-3 w-3" />
          </button>
        </div>
      </td>
    </tr>
  );
}

function compare(a: CampaignRow, b: CampaignRow, key: SortKey, dir: "asc" | "desc"): number {
  const sign = dir === "asc" ? 1 : -1;
  const av = pick(a, key);
  const bv = pick(b, key);
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  if (typeof av === "string" && typeof bv === "string") return sign * av.localeCompare(bv);
  return sign * ((av as number) - (bv as number));
}

function pick(c: CampaignRow, key: SortKey): string | number | null {
  switch (key) {
    case "name": return c.name;
    case "budget": return c.dailyBudget ?? c.lifetimeBudget ?? null;
    case "results": return c.results;
    case "costPerResult": return c.costPerResult;
    case "spend": return c.spend;
    case "ctr": return c.ctr;
    case "purchaseRoas": return c.purchaseRoas;
  }
}
