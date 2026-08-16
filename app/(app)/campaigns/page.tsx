import Link from "next/link";
import type { Metadata } from "next";
import { Topbar } from "@/components/app-shell/Topbar";
import { getAppSession } from "@/lib/auth/session";
import { resolveActiveProject } from "@/lib/auth/active-project";
import { listCampaignsForProject } from "@/lib/db/queries/manager";
import { rangeForPreset, type DashboardRange } from "@/lib/db/queries/dashboard";
import { ManagerTabs } from "./ManagerTabs";
import { ManagerToolbar } from "./ManagerToolbar";
import { CampaignsTable } from "./CampaignsTable";

// Own icon + home-screen label so a "/campaigns" shortcut is distinct from the app root.
export const metadata: Metadata = {
  title: "Campaigns",
  // Own manifest: installed shortcuts launch at the manifest start_url, so this
  // must be route-scoped or the tile opens "/" -> /dashboard.
  manifest: "/manifest-campaigns.webmanifest",
  appleWebApp: { capable: true, title: "Campaigns", statusBarStyle: "default" },
};

const VALID_RANGES = new Set<DashboardRange>([
  "today",
  "yesterday",
  "last_7d",
  "last_30d",
  "max",
]);

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; q?: string; active?: string; ad_account?: string }>;
}) {
  const session = await getAppSession();
  if (!session) return null;

  const active = await resolveActiveProject({
    orgId: session.orgId,
    userId: session.userId,
  });
  if (!active) {
    return (
      <>
        <Topbar title="Ads Manager" subtitle="No active project" />
        <ManagerTabs active="campaigns" />
        <EmptyHint
          title="No project selected"
          body="Pick or create a project from the topbar."
          ctaHref="/settings/projects"
          ctaLabel="Manage projects"
        />
      </>
    );
  }

  const { range: rangeParam, q, active: activeParam, ad_account } = await searchParams;
  const range: DashboardRange = VALID_RANGES.has(rangeParam as DashboardRange)
    ? (rangeParam as DashboardRange)
    : "today";
  const search = (q ?? "").trim();
  const activeOnly = activeParam !== "0";
  const adAccountFilter = (ad_account ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const { start, end } = rangeForPreset(range);
  const allGroups = await listCampaignsForProject({
    orgId: session.orgId,
    projectId: active.id,
    rangeStart: start,
    rangeEnd: end,
    activeOnly,
  });

  // Build the ad-account dropdown options from the unfiltered list so the
  // user can always switch back. Names mirror the Ad Sets tab.
  const adAccountOptions = Array.from(
    new Set(allGroups.map((g) => g.adAccountName)),
  )
    .filter(Boolean)
    .sort();

  const adAccountSet = new Set(adAccountFilter);
  const groups =
    adAccountSet.size > 0
      ? allGroups.filter((g) => adAccountSet.has(g.adAccountName))
      : allGroups;

  const totalCampaigns = groups.reduce((n, g) => n + g.campaigns.length, 0);

  return (
    <>
      <Topbar
        title="Ads Manager"
        subtitle={`${active.name} · ${groups.length} ad account${groups.length === 1 ? "" : "s"} · ${totalCampaigns} ${activeOnly ? "active " : ""}campaign${totalCampaigns === 1 ? "" : "s"}`}
      />
      <ManagerTabs active="campaigns" />
      <ManagerToolbar
        range={range}
        search={search}
        activeOnly={activeOnly}
        adAccounts={adAccountFilter}
        adAccountOptions={adAccountOptions}
      />
      <div className="flex-1 overflow-auto bg-white dark:bg-zinc-950">
        {groups.length === 0 ? (
          <EmptyHint
            title="No campaigns to show"
            body={
              activeOnly
                ? "Either there are no active campaigns yet, or your insights haven't synced. Try toggling Active only off, or syncing in Settings."
                : "No campaigns are cached for this project yet. Connect Meta and sync in Settings."
            }
            ctaHref="/settings"
            ctaLabel="Open settings"
          />
        ) : (
          <CampaignsTable groups={groups} search={search} />
        )}
      </div>
    </>
  );
}

function EmptyHint({
  title,
  body,
  ctaHref,
  ctaLabel,
}: {
  title: string;
  body: string;
  ctaHref: string;
  ctaLabel: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
        {title}
      </h2>
      <p className="max-w-md text-sm text-zinc-500">{body}</p>
      <Link
        href={ctaHref}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
      >
        {ctaLabel}
      </Link>
    </div>
  );
}
