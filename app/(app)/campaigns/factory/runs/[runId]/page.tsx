import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { Topbar } from "@/components/app-shell/Topbar";
import { getAppSession } from "@/lib/auth/session";
import { db, schema } from "@/lib/db/client";
import type { FactoryRunItem } from "@/lib/inngest/factory-run";
import { ManagerTabs } from "../../../ManagerTabs";
import { LivePoll } from "@/components/LivePoll";
import { StatusBadge } from "../../../clone-jobs/StatusBadge";
import { ActivatePanel } from "./ActivatePanel";

export default async function FactoryRunDetailPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const session = await getAppSession();
  if (!session) return null;
  const { runId } = await params;

  const [run] = await db
    .select()
    .from(schema.factoryRuns)
    .where(and(eq(schema.factoryRuns.id, runId), eq(schema.factoryRuns.orgId, session.orgId)))
    .limit(1);
  if (!run) notFound();

  const items = (run.items as FactoryRunItem[] | null) ?? [];
  const processed = run.created + run.skipped + run.failed;
  const pct =
    run.total > 0
      ? Math.round((processed / run.total) * 100)
      : run.status === "done"
        ? 100
        : 0;
  const live = run.status === "queued" || run.status === "running";
  const activatable = items
    .filter((i) => i.status === "created" && i.draftAdId)
    .map((i) => ({
      draftAdId: i.draftAdId!,
      localAdSetId: i.localAdSetId,
      adSetName: i.adSetName,
      fileName: i.fileName,
    }));

  return (
    <>
      <Topbar title="Ads Manager" subtitle="Factory bulk run" />
      <ManagerTabs active="factory" />
      {live && <LivePoll intervalSeconds={10} />}
      <div className="space-y-4 p-6">
        <Link
          href="/campaigns/factory/runs"
          className="text-xs text-blue-600 hover:underline dark:text-blue-400"
        >
          ← All bulk runs
        </Link>

        <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate font-mono font-medium text-zinc-900 dark:text-zinc-100">
                {run.batchSlug}
              </div>
              <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                {run.total} creatives → {run.total} new ad sets (1 ad each), all PAUSED
              </div>
            </div>
            <StatusBadge status={run.status} />
          </div>

          <div className="mt-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {run.created} / {run.total || "?"} created · {run.skipped} skipped · {run.failed} failed
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            <div
              className="h-full rounded-full bg-blue-500 transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          {live && (
            <p className="mt-2 text-xs text-zinc-400">
              Running in the background — safe to close this tab. This page refreshes itself.
            </p>
          )}
          {run.error && (
            <p className="mt-2 text-sm text-red-600 dark:text-red-400">{run.error}</p>
          )}
        </div>

        {!live && activatable.length > 0 ? <ActivatePanel items={activatable} /> : null}

        <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-zinc-500">
              <tr className="border-b border-zinc-200 dark:border-zinc-800">
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">File</th>
                <th className="px-3 py-2">Kind</th>
                <th className="px-3 py-2">Ad set</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {items.map((it) => (
                <tr key={it.index}>
                  <td className="px-3 py-1.5 text-zinc-400">{it.index + 1}</td>
                  <td className="max-w-56 truncate px-3 py-1.5 font-mono text-[11px]">
                    {it.fileName}
                  </td>
                  <td className="px-3 py-1.5">{it.kind}</td>
                  <td className="px-3 py-1.5 font-mono text-[11px]">{it.adSetName}</td>
                  <td className="px-3 py-1.5">
                    <span
                      className={
                        it.status === "created"
                          ? "rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                          : it.status === "failed"
                            ? "rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-red-700 dark:bg-red-950 dark:text-red-300"
                            : "rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                      }
                    >
                      {it.status.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="max-w-72 truncate px-3 py-1.5 font-mono text-[10px] text-zinc-500">
                    {it.status === "created"
                      ? `ad ${it.metaAdId} · adset ${it.metaAdSetId}`
                      : (it.error ?? "")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
