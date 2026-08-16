import Link from "next/link";
import { notFound } from "next/navigation";
import { Topbar } from "@/components/app-shell/Topbar";
import { getAppSession } from "@/lib/auth/session";
import { db, schema } from "@/lib/db/client";
import { and, desc, eq, gte } from "drizzle-orm";
import { formatMyr, formatNumber } from "@/lib/utils";
import { AdQuickAction } from "../../AdActions";

const KL_TZ = "Asia/Kuala_Lumpur";

export default async function AdDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getAppSession();
  if (!session) return null;
  const { id } = await params;

  const [ad] = await db
    .select({
      id: schema.ads.id,
      metaAdId: schema.ads.metaAdId,
      name: schema.ads.name,
      status: schema.ads.status,
      effectiveStatus: schema.ads.effectiveStatus,
      lastSyncedAt: schema.ads.lastSyncedAt,
      adSetId: schema.ads.adSetId,
      adSetName: schema.adSets.name,
      campaignName: schema.campaigns.name,
      campaignObjective: schema.campaigns.objective,
      adAccountId: schema.campaigns.adAccountId,
    })
    .from(schema.ads)
    .innerJoin(schema.adSets, eq(schema.adSets.id, schema.ads.adSetId))
    .innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.adSets.campaignId))
    .where(
      and(eq(schema.ads.orgId, session.orgId), eq(schema.ads.id, id)),
    )
    .limit(1);
  if (!ad) notFound();

  const [account] = await db
    .select({
      name: schema.adAccounts.name,
      lastSyncedAt: schema.adAccounts.lastSyncedAt,
    })
    .from(schema.adAccounts)
    .where(eq(schema.adAccounts.id, ad.adAccountId))
    .limit(1);

  // Last 30 daily insight rows for this ad.
  const since = new Date(Date.now() - 30 * 86_400_000);
  const insights = await db
    .select({
      date: schema.insightsDaily.date,
      spend: schema.insightsDaily.spend,
      results: schema.insightsDaily.results,
      impressions: schema.insightsDaily.impressions,
      clicks: schema.insightsDaily.clicks,
      ctr: schema.insightsDaily.ctr,
      cpm: schema.insightsDaily.cpm,
      purchaseRoas: schema.insightsDaily.purchaseRoas,
      costPerResult: schema.insightsDaily.costPerResult,
    })
    .from(schema.insightsDaily)
    .where(
      and(
        eq(schema.insightsDaily.orgId, session.orgId),
        eq(schema.insightsDaily.entityId, ad.id),
        eq(schema.insightsDaily.level, "ad"),
        gte(schema.insightsDaily.date, since),
      ),
    )
    .orderBy(desc(schema.insightsDaily.date));

  // Journal entries about this ad.
  const journal = await db
    .select({
      id: schema.decisionJournal.id,
      occurredAt: schema.decisionJournal.occurredAt,
      actorType: schema.decisionJournal.actorType,
      actorRef: schema.decisionJournal.actorRef,
      summary: schema.decisionJournal.summary,
      reasoning: schema.decisionJournal.reasoning,
    })
    .from(schema.decisionJournal)
    .where(
      and(
        eq(schema.decisionJournal.orgId, session.orgId),
        eq(schema.decisionJournal.entityKind, "ad"),
        eq(schema.decisionJournal.entityId, ad.id),
      ),
    )
    .orderBy(desc(schema.decisionJournal.occurredAt))
    .limit(50);

  // Aggregate the 30d window.
  const totals = insights.reduce(
    (acc, r) => ({
      spend: acc.spend + Number(r.spend ?? 0),
      results: acc.results + Number(r.results ?? 0),
      impressions: acc.impressions + Number(r.impressions ?? 0),
      clicks: acc.clicks + Number(r.clicks ?? 0),
    }),
    { spend: 0, results: 0, impressions: 0, clicks: 0 },
  );

  // Build a tiny inline sparkline for spend (no chart library — pure SVG).
  const maxSpend = Math.max(
    1,
    ...insights.map((r) => Number(r.spend ?? 0)),
  );
  const sparkPoints = [...insights]
    .reverse() // oldest → newest
    .map((r, i, arr) => {
      const x = arr.length === 1 ? 0 : (i / (arr.length - 1)) * 100;
      const y = 30 - (Number(r.spend ?? 0) / maxSpend) * 28;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const isPaused =
    ad.effectiveStatus === "PAUSED" ||
    ad.effectiveStatus === "ADSET_PAUSED" ||
    ad.effectiveStatus === "CAMPAIGN_PAUSED";

  return (
    <>
      <Topbar
        title={ad.name}
        subtitle={
          <Link href="/dashboard" className="hover:text-zinc-900 dark:hover:text-zinc-100">
            ← Dashboard
          </Link>
        }
      />
      <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-8">
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1 text-xs text-zinc-500">
              <span>
                <strong>Account:</strong> {account?.name ?? "—"}
              </span>
              <span>
                <strong>Campaign:</strong> {ad.campaignName} ({ad.campaignObjective ?? "no objective"})
              </span>
              <span>
                <strong>Ad set:</strong> {ad.adSetName}
              </span>
              <span>
                <strong>Status:</strong> {ad.effectiveStatus ?? ad.status}
              </span>
              <span>
                <strong>Meta ad ID:</strong>{" "}
                <code className="font-mono">{ad.metaAdId}</code>
              </span>
              <span>
                <strong>Last synced:</strong>{" "}
                {(account?.lastSyncedAt ?? ad.lastSyncedAt).toLocaleString(
                  "en-MY",
                  { timeZone: KL_TZ },
                )}
              </span>
            </div>
            <AdQuickAction adId={ad.id} isPaused={isPaused} />
          </div>
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <h3 className="text-sm font-semibold">Last 30 days</h3>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Spend" value={formatMyr(totals.spend)} />
            <Stat label="Results" value={formatNumber(totals.results)} />
            <Stat
              label="Cost per result"
              value={
                totals.results > 0
                  ? formatMyr(totals.spend / totals.results)
                  : "—"
              }
            />
            <Stat label="Clicks" value={formatNumber(totals.clicks)} />
          </div>
          {insights.length > 0 ? (
            <div className="mt-4">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                Daily spend
              </span>
              <svg
                viewBox="0 0 100 30"
                preserveAspectRatio="none"
                className="mt-1 h-16 w-full"
              >
                <polyline
                  points={sparkPoints}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="0.5"
                  className="text-blue-600"
                />
              </svg>
              <div className="mt-3 max-h-64 overflow-y-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-[10px] uppercase tracking-wider text-zinc-500">
                    <tr>
                      <th className="py-1">Date</th>
                      <th className="py-1">Spend</th>
                      <th className="py-1">Results</th>
                      <th className="py-1">CPR</th>
                      <th className="py-1">CTR</th>
                      <th className="py-1">Clicks</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {insights.map((r, i) => (
                      <tr key={i}>
                        <td className="py-1.5">
                          {r.date.toLocaleDateString("en-MY", {
                            timeZone: KL_TZ,
                            month: "short",
                            day: "numeric",
                          })}
                        </td>
                        <td className="py-1.5">{formatMyr(r.spend ?? 0)}</td>
                        <td className="py-1.5">
                          {formatNumber(Number(r.results ?? 0))}
                        </td>
                        <td className="py-1.5">
                          {r.costPerResult ? formatMyr(r.costPerResult) : "—"}
                        </td>
                        <td className="py-1.5">
                          {r.ctr ? `${Number(r.ctr).toFixed(2)}%` : "—"}
                        </td>
                        <td className="py-1.5">
                          {formatNumber(Number(r.clicks ?? 0))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <p className="mt-3 text-xs text-zinc-500">
              No insight rows cached for this ad yet — refresh the dashboard to
              pull them.
            </p>
          )}
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <h3 className="text-sm font-semibold">
            History ({journal.length} entries)
          </h3>
          {journal.length === 0 ? (
            <p className="mt-2 text-xs text-zinc-500">
              No actions on this ad yet (it hasn't been paused, resumed, or
              touched by a rule from this app).
            </p>
          ) : (
            <ol className="relative mt-3 ml-2 border-l border-zinc-200 dark:border-zinc-800">
              {journal.map((j) => (
                <li key={j.id} className="ml-4 mb-3">
                  <span className="absolute -left-[5px] mt-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-zinc-300 dark:border-zinc-950" />
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-medium uppercase tracking-wider dark:bg-zinc-800">
                      {j.actorType}
                    </span>
                    <span>
                      {j.occurredAt.toLocaleString("en-MY", {
                        timeZone: KL_TZ,
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs">{j.summary}</p>
                  {j.reasoning ? (
                    <p className="text-[11px] text-zinc-500">{j.reasoning}</p>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </div>
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
      <span className="text-base font-semibold tabular-nums">{value}</span>
    </div>
  );
}
