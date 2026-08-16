import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { Topbar } from "@/components/app-shell/Topbar";
import { getAppSession } from "@/lib/auth/session";
import { db, schema } from "@/lib/db/client";
import { ManagerTabs } from "../../ManagerTabs";
import { LivePoll } from "@/components/LivePoll";
import { StatusBadge } from "../../clone-jobs/StatusBadge";

export default async function FactoryRunsPage() {
  const session = await getAppSession();
  if (!session) return null;

  const runs = await db
    .select()
    .from(schema.factoryRuns)
    .where(eq(schema.factoryRuns.orgId, session.orgId))
    .orderBy(desc(schema.factoryRuns.createdAt))
    .limit(50);

  const anyLive = runs.some((r) => r.status === "queued" || r.status === "running");

  return (
    <>
      <Topbar title="Ads Manager" subtitle="Factory bulk runs" />
      <ManagerTabs active="factory" />
      {anyLive && <LivePoll intervalSeconds={20} />}
      <div className="p-6">
        <Link
          href="/campaigns/factory"
          className="text-xs text-blue-600 hover:underline dark:text-blue-400"
        >
          ← Factory
        </Link>
        {runs.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            No bulk runs yet. Start one from the Factory tab's Bulk launch mode.
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {runs.map((r) => (
              <Link
                key={r.id}
                href={`/campaigns/factory/runs/${r.id}`}
                className="block rounded-lg border border-zinc-200 p-3 text-sm hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate font-mono font-medium text-zinc-900 dark:text-zinc-100">
                    {r.batchSlug}
                  </span>
                  <StatusBadge status={r.status} />
                </div>
                <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  {r.created}/{r.total || "?"} created · {r.skipped} skipped · {r.failed} failed
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
