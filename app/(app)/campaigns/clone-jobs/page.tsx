import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { Topbar } from "@/components/app-shell/Topbar";
import { getAppSession } from "@/lib/auth/session";
import { db, schema } from "@/lib/db/client";
import { ManagerTabs } from "../ManagerTabs";
import { LivePoll } from "@/components/LivePoll";
import { StatusBadge } from "./StatusBadge";

export default async function CloneJobsPage() {
  const session = await getAppSession();
  if (!session) return null;

  const jobs = await db
    .select()
    .from(schema.cloneJobs)
    .where(eq(schema.cloneJobs.orgId, session.orgId))
    .orderBy(desc(schema.cloneJobs.createdAt))
    .limit(50);

  const anyLive = jobs.some((j) => j.status === "queued" || j.status === "running");

  return (
    <>
      <Topbar title="Ads Manager" subtitle="Clone jobs" />
      <ManagerTabs active="clone-jobs" />
      {anyLive && <LivePoll intervalSeconds={20} />}
      <div className="p-6">
        {jobs.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No clone jobs yet. Start one with the Copy (⧉) button on a campaign row in the Campaigns tab.
          </p>
        ) : (
          <div className="space-y-2">
            {jobs.map((j) => (
              <Link
                key={j.id}
                href={`/campaigns/clone-jobs/${j.id}`}
                className="block rounded-lg border border-zinc-200 p-3 text-sm hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate font-medium text-zinc-900 dark:text-zinc-100">
                    {j.sourceCampaignName}
                  </span>
                  <StatusBadge status={j.status} />
                </div>
                <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  → {j.destAccountName} · {j.cloned}/{j.total || "?"} cloned · {j.skipped} skipped · {j.failed} failed
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
