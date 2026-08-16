import Link from "next/link";
import type { Metadata } from "next";
import { Sparkles } from "lucide-react";
import { Topbar } from "@/components/app-shell/Topbar";
import { getAppSession } from "@/lib/auth/session";
import { resolveActiveProject } from "@/lib/auth/active-project";
import {
  listDashboardAdsPaged,
  rangeForPreset,
  type DashboardRange,
} from "@/lib/db/queries/dashboard";
import { db, schema } from "@/lib/db/client";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { AdGrid } from "./AdGrid";
import { DashboardToolbar } from "./DashboardToolbar";
import { LoadMoreButton } from "@/components/LoadMoreButton";
import { formatMyr, formatNumber } from "@/lib/utils";

// Headroom over Vercel's default function timeout — the dashboard query
// still pulls every ad row for the project (26k+) before filtering.
export const maxDuration = 60;

// Own icon + home-screen label so a "/dashboard" shortcut is distinct from the app root.
export const metadata: Metadata = {
  title: "Dashboard",
  // Own manifest: installed shortcuts launch at the manifest start_url, so this
  // must be route-scoped or the tile opens "/" -> /dashboard.
  manifest: "/manifest-dashboard.webmanifest",
  appleWebApp: { capable: true, title: "Dashboard", statusBarStyle: "default" },
};

const VALID_RANGES = new Set<DashboardRange>([
  "today",
  "yesterday",
  "last_7d",
  "last_30d",
]);

/** Cards rendered before the operator clicks "Load more". The main project
 *  has 1000+ active ads; shipping them all to the client AdGrid froze
 *  scrolling on mobile. Totals/counts still cover the full filtered set. */
const PAGE_SIZE = 60;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{
    range?: string;
    q?: string;
    campaign?: string;
    alerts?: string;
    active?: string;
    view?: string;
    sort?: string;
    n?: string;
  }>;
}) {
  const session = await getAppSession();
  if (!session) return null;

  const {
    range: rangeParam,
    q,
    campaign,
    alerts,
    active: activeParam,
    view: viewParam,
    sort: sortParam,
    n: nParam,
  } = await searchParams;
  const range: DashboardRange = VALID_RANGES.has(rangeParam as DashboardRange)
    ? (rangeParam as DashboardRange)
    : "yesterday";
  const search = (q ?? "").trim().toLowerCase();
  const campaignFilter = (campaign ?? "").trim();
  const alertsOnly = alerts === "1";
  // Default ON: show only active ads unless user explicitly sets active=0
  const activeOnly = activeParam !== "0";
  const view: "all" | "keep" | "kill" =
    viewParam === "keep" || viewParam === "kill" ? viewParam : "all";
  // Default to newest-created first; operator can flip to highest-spend.
  const sort: "newest" | "spend" = sortParam === "spend" ? "spend" : "newest";
  const nParsed = Number.parseInt(nParam ?? "", 10);
  const limit = Number.isFinite(nParsed)
    ? Math.min(Math.max(nParsed, PAGE_SIZE), 2000)
    : PAGE_SIZE;

  const active = await resolveActiveProject({
    orgId: session.orgId,
    userId: session.userId,
  });

  if (!active) {
    return (
      <>
        <Topbar
          title="Ads Manager Dashboard"
          subtitle="No active project"
        />
        <EmptyState
          title="Workspace not provisioned yet"
          body="Run scripts/bootstrap-lite.ts to create the project and attach the two ad accounts."
          ctaHref={null}
          ctaLabel={null}
        />
      </>
    );
  }

  // Confirm there's at least one ad account assigned to this project.
  const accountCount = await db
    .select({ id: schema.adAccounts.id })
    .from(schema.adAccounts)
    .where(
      and(
        eq(schema.adAccounts.orgId, session.orgId),
        eq(schema.adAccounts.projectId, active.id),
      ),
    );

  // Last sync timestamp for the freshness label — account-level stamp
  // (per-ad lastSyncedAt only advances when a row changes, since the sync
  // upserts skip unchanged rows).
  const accountIdsForSync = accountCount.map((a) => a.id);
  const lastSyncRows =
    accountIdsForSync.length === 0
      ? []
      : await db
          .select({ lastSyncedAt: schema.adAccounts.lastSyncedAt })
          .from(schema.adAccounts)
          .where(
            and(
              eq(schema.adAccounts.orgId, session.orgId),
              inArray(schema.adAccounts.id, accountIdsForSync),
            ),
          )
          .orderBy(desc(schema.adAccounts.lastSyncedAt))
          .limit(1);
  const lastSyncedAt = lastSyncRows[0]?.lastSyncedAt ?? null;

  if (accountCount.length === 0) {
    return (
      <>
        <Topbar
          title={active.name}
          subtitle="Project has no ad accounts assigned yet"
        />
        <EmptyState
          title="No ad accounts attached"
          body="Run scripts/bootstrap-lite.ts to attach act_1690421202260749 and act_1386521543403841 to this project."
          ctaHref={null}
          ctaLabel={null}
        />
      </>
    );
  }

  const { start, end } = rangeForPreset(range);
  // All filtering / status bucketing / aggregation / sort / cap runs in SQL
  // so the page never pulls the project's whole ads table into Node.
  const page = await listDashboardAdsPaged({
    orgId: session.orgId,
    projectId: active.id,
    rangeStart: start,
    rangeEnd: end,
    search: search || undefined,
    campaign: campaignFilter || undefined,
    alertsOnly,
    activeOnly,
    view,
    sort,
    limit,
  });

  // `visible` is already the paged, filtered, sorted slice; totals/counts
  // cover the full filtered set, grandTotal is every project ad (subtitle
  // denominator), groupTotals feeds AdGrid's "X of Y ads" headers.
  const {
    cards: visible,
    totalCount,
    grandTotal,
    totals,
    counts: preViewCounts,
    groupTotals,
    campaignOptions,
  } = page;
  const cpr = totals.results > 0 ? totals.spend / totals.results : null;

  return (
    <>
      <Topbar
        title={active.name}
        subtitle={`${accountCount.length} ad account${accountCount.length === 1 ? "" : "s"} · ${totalCount}${totalCount !== grandTotal ? `/${grandTotal}` : ""} ads${lastSyncedAt ? ` · synced ${formatRelative(lastSyncedAt)}` : " · never synced"}`}
      />
      <DashboardToolbar
        activeRange={range}
        search={search}
        campaign={campaignFilter}
        campaignOptions={campaignOptions}
        alertsOnly={alertsOnly}
        activeOnly={activeOnly}
        view={view}
        sort={sort}
        counts={preViewCounts}
      />

      <div className="flex flex-1 flex-col overflow-y-auto">
        <div className="grid grid-cols-2 gap-3 border-b border-zinc-200 bg-zinc-50 px-6 py-4 sm:grid-cols-4 dark:border-zinc-800 dark:bg-zinc-900">
          <Stat label="Spend" value={formatMyr(totals.spend)} />
          <Stat label="Results" value={formatNumber(totals.results)} />
          <Stat
            label="Cost per result"
            value={cpr !== null ? formatMyr(cpr) : "—"}
          />
          <Stat label="Clicks" value={formatNumber(totals.clicks)} />
        </div>

        {grandTotal === 0 ? (
          <div className="p-8">
            <EmptyState
              title="No ad data cached yet"
              body={'Click "Refresh from Meta" above to pull campaigns, ad sets, ads, and insights for this project.'}
              ctaHref={null}
              ctaLabel={null}
            />
          </div>
        ) : totalCount === 0 ? (
          <div className="p-8">
            <EmptyState
              title="No ads match your filter"
              body={`${grandTotal} ads loaded but none match${search ? ` "${search}"` : ""}${campaignFilter ? ` in ${campaignFilter}` : ""}. Clear the filter to see all ads.`}
              ctaHref={`/dashboard?range=${range}`}
              ctaLabel="Clear filter"
            />
          </div>
        ) : (
          <>
            <AdGrid cards={visible} groupTotals={groupTotals} />
            {visible.length < totalCount ? (
              <LoadMoreButton
                shown={visible.length}
                total={totalCount}
                step={PAGE_SIZE}
              />
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">
        {label}
      </span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function EmptyState({
  title,
  body,
  ctaHref,
  ctaLabel,
}: {
  title: string;
  body: string;
  ctaHref: string | null;
  ctaLabel: string | null;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-12 text-center">
      <h3 className="text-base font-medium">{title}</h3>
      <p className="max-w-md text-sm text-zinc-500">{body}</p>
      {ctaHref && ctaLabel ? (
        <Link
          href={ctaHref}
          className="mt-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          {ctaLabel}
        </Link>
      ) : null}
    </div>
  );
}

function formatRelative(d: Date): string {
  const ms = Date.now() - d.getTime();
  if (ms < 60_000) return "just now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  return `${days}d ago`;
}
