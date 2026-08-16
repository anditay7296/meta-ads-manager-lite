import { Topbar } from "@/components/app-shell/Topbar";
import { getAppSession } from "@/lib/auth/session";
import { resolveActiveProject } from "@/lib/auth/active-project";
import { rangeForPreset, type DashboardRange } from "@/lib/db/queries/dashboard";
import { listAdSetsForProject } from "@/lib/db/queries/manager";
import { ManagerTabs } from "../ManagerTabs";
import { AdSetsTable } from "../AdSetsTable";
import { AdSetsToolbar } from "./AdSetsToolbar";

const VALID_RANGES = new Set<DashboardRange>([
  "today",
  "yesterday",
  "last_7d",
  "last_30d",
  "max",
]);

export default async function AdSetsPage({
  searchParams,
}: {
  searchParams: Promise<{
    range?: string;
    q?: string;
    ad_account?: string;
    campaign?: string;
    active_campaigns?: string;
  }>;
}) {
  const session = await getAppSession();
  if (!session) return null;

  const {
    range: rangeParam,
    q,
    ad_account,
    campaign,
    active_campaigns,
  } = await searchParams;

  const range: DashboardRange = VALID_RANGES.has(rangeParam as DashboardRange)
    ? (rangeParam as DashboardRange)
    : "today";
  const search = (q ?? "").trim().toLowerCase();
  // CSV-encoded ad-account filter: empty = all accounts, otherwise narrow to
  // the listed names. Comma is fine as a separator since none of Andi's ad
  // account names contain commas.
  const adAccountFilter = (ad_account ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const campaignFilter = (campaign ?? "").trim();
  // Default ON: hide ad sets in paused/archived campaigns unless user
  // explicitly disables via active_campaigns=0. Mirrors the dashboard pattern.
  const activeCampaignsOnly = active_campaigns !== "0";

  const active = await resolveActiveProject({
    orgId: session.orgId,
    userId: session.userId,
  });

  if (!active) {
    return (
      <>
        <Topbar title="Ads Manager" subtitle="Ad sets — no active project" />
        <ManagerTabs active="adsets" />
        <div className="flex flex-1 items-center justify-center p-12 text-sm text-zinc-500">
          No active project — run scripts/bootstrap-lite.ts.
        </div>
      </>
    );
  }

  const { start, end } = rangeForPreset(range);
  const allGroups = await listAdSetsForProject({
    orgId: session.orgId,
    projectId: active.id,
    rangeStart: start,
    rangeEnd: end,
    activeCampaignsOnly,
  });

  // Ad account dropdown options come from the unfiltered list so the user can
  // always switch back. Distinct campaigns recompute against the current
  // ad-account filter so the campaign list stays scoped.
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

  const campaignOptions = Array.from(
    new Set(groups.map((g) => g.campaignName)),
  )
    .filter(Boolean)
    .sort();

  const totalAdSets = groups.reduce((n, g) => n + g.adSets.length, 0);
  const totalCampaigns = groups.length;

  return (
    <>
      <Topbar
        title={active.name}
        subtitle={`${totalAdSets} ad set${totalAdSets === 1 ? "" : "s"} across ${totalCampaigns} campaign${totalCampaigns === 1 ? "" : "s"}`}
      />
      <ManagerTabs active="adsets" />
      <AdSetsToolbar
        range={range as "today" | "yesterday" | "last_7d" | "last_30d" | "max"}
        search={search}
        adAccounts={adAccountFilter}
        adAccountOptions={adAccountOptions}
        campaign={campaignFilter}
        campaignOptions={campaignOptions}
        activeCampaignsOnly={activeCampaignsOnly}
      />
      <div className="flex flex-1 flex-col overflow-y-auto">
        {groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 p-12 text-center">
            <h3 className="text-base font-medium">No ad set data cached yet</h3>
            <p className="max-w-md text-sm text-zinc-500">
              Click &ldquo;Refresh from Meta&rdquo; above to sync campaigns,
              ad sets, ads, and insights for this project.
            </p>
          </div>
        ) : (
          <AdSetsTable
            groups={groups}
            search={search}
            campaignFilter={campaignFilter}
          />
        )}
      </div>
    </>
  );
}
