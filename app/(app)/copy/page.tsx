import Link from "next/link";
import { Topbar } from "@/components/app-shell/Topbar";
import { getAppSession } from "@/lib/auth/session";
import { listCopyEntries } from "@/lib/db/queries/copy";
import { CreateEntryForm } from "./CreateEntryForm";

export default async function CopyPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tag?: string }>;
}) {
  const session = await getAppSession();
  if (!session) return null;
  const params = await searchParams;
  const entries = await listCopyEntries({
    orgId: session.orgId,
    search: params.q || null,
    tag: params.tag || null,
  });

  return (
    <>
      <Topbar
        title="Copywriting library"
        subtitle={`${entries.length} entries · feeds the bulk variation factory on /campaigns`}
      />
      <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-4 sm:p-8">
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <h3 className="text-sm font-semibold">Create a new entry</h3>
          <p className="mt-1 text-xs text-zinc-500">
            Each entry holds up to 4 variants (matches Meta's multi-text
            feature). Tag by audience, funnel stage, and pain-point slug so the
            variation factory can find the right copy.
          </p>
          <div className="mt-4">
            <CreateEntryForm />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <form className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="Search title, audience, slug…"
              className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs sm:flex-none dark:border-zinc-700 dark:bg-zinc-950"
            />
            <input
              type="text"
              name="tag"
              defaultValue={params.tag ?? ""}
              placeholder="Filter by tag"
              className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs sm:flex-none dark:border-zinc-700 dark:bg-zinc-950"
            />
            <button
              type="submit"
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
            >
              Filter
            </button>
            {(params.q || params.tag) && (
              <Link
                href="/copy"
                className="text-xs text-zinc-500 underline-offset-2 hover:underline"
              >
                Clear
              </Link>
            )}
          </form>
        </div>

        {entries.length === 0 ? (
          <div className="rounded-md border border-dashed border-zinc-300 bg-zinc-50 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900">
            No entries yet — create your first above.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-100 text-[10px] uppercase tracking-wider text-zinc-500 dark:border-zinc-800">
                <tr>
                  <th className="p-3">Title</th>
                  <th className="p-3">Slug</th>
                  <th className="p-3">Audience</th>
                  <th className="p-3">Funnel</th>
                  <th className="p-3">Tags</th>
                  <th className="p-3">Variants</th>
                  <th className="p-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="p-3 text-xs">{e.title}</td>
                    <td className="p-3 font-mono text-[11px] text-zinc-500">
                      {e.painPointSlug ?? "—"}
                    </td>
                    <td className="p-3 text-xs">{e.audience ?? "—"}</td>
                    <td className="p-3 text-xs">{e.funnelStage ?? "—"}</td>
                    <td className="p-3 text-xs text-zinc-500">
                      {e.tags && e.tags.length > 0 ? e.tags.join(", ") : "—"}
                    </td>
                    <td className="p-3 text-xs">{e.variantCount}</td>
                    <td className="p-3 text-xs">
                      <Link
                        href={`/copy/${e.id}`}
                        className="text-blue-600 hover:underline"
                      >
                        Edit →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
