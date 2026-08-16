import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { Topbar } from "@/components/app-shell/Topbar";
import { getAppSession } from "@/lib/auth/session";
import { db, schema } from "@/lib/db/client";
import { ManagerTabs } from "../../ManagerTabs";
import { LivePoll } from "@/components/LivePoll";
import { StatusBadge } from "../StatusBadge";

type PerAdSet = {
  name: string;
  status: "cloned" | "skipped" | "failed";
  newAdSetMetaId?: string;
  needsManualIgFix?: number;
  error?: string;
};

export default async function CloneJobDetailPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const session = await getAppSession();
  if (!session) return null;
  const { jobId } = await params;

  const [job] = await db
    .select()
    .from(schema.cloneJobs)
    .where(and(eq(schema.cloneJobs.id, jobId), eq(schema.cloneJobs.orgId, session.orgId)))
    .limit(1);
  if (!job) notFound();

  const per = (job.perAdSet as PerAdSet[] | null) ?? [];
  const failures = per.filter((p) => p.status === "failed");
  const igFixes = per.filter((p) => (p.needsManualIgFix ?? 0) > 0);
  const processed = job.cloned + job.skipped + job.failed;
  const pct = job.total > 0 ? Math.round((processed / job.total) * 100) : job.status === "done" ? 100 : 0;
  const live = job.status === "queued" || job.status === "running";

  return (
    <>
      <Topbar title="Ads Manager" subtitle="Clone job" />
      <ManagerTabs active="clone-jobs" />
      {live && <LivePoll intervalSeconds={15} />}
      <div className="space-y-4 p-6">
        <Link href="/campaigns/clone-jobs" className="text-xs text-blue-600 hover:underline dark:text-blue-400">
          ← All clone jobs
        </Link>

        <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate font-medium text-zinc-900 dark:text-zinc-100">{job.sourceCampaignName}</div>
              <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                {job.sourceMetaAccountId} → {job.destAccountName} ({job.destMetaAccountId})
              </div>
            </div>
            <StatusBadge status={job.status} />
          </div>

          <div className="mt-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {job.cloned} / {job.total || "?"} cloned · {job.skipped} skipped · {job.failed} failed
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            <div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
          {live && (
            <p className="mt-2 text-xs text-zinc-400">
              Running in the background — safe to close this tab. This page refreshes itself.
            </p>
          )}
          {job.error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{job.error}</p>}
        </div>

        {igFixes.length > 0 && (
          <div className="rounded-xl border border-pink-200 bg-pink-50 p-4 dark:border-pink-900 dark:bg-pink-950/30">
            <div className="text-sm font-medium text-pink-800 dark:text-pink-300">
              🔧 {igFixes.length} cloned ad set(s) have IG-native ads needing a manual “Change post” → Instagram in Ads
              Manager
            </div>
            <ul className="mt-2 space-y-0.5 text-xs text-pink-700 dark:text-pink-400">
              {igFixes.map((p, i) => (
                <li key={i} className="truncate">{p.name}</li>
              ))}
            </ul>
          </div>
        )}

        {failures.length > 0 && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/30">
            <div className="text-sm font-medium text-red-800 dark:text-red-300">
              {failures.length} ad set(s) failed — re-run the clone (it skips everything already done) to retry.
            </div>
            <ul className="mt-2 space-y-1 text-xs text-red-700 dark:text-red-400">
              {failures.map((p, i) => (
                <li key={i}>
                  <span className="font-medium">{p.name}</span> — {p.error ?? "unknown error"}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </>
  );
}
