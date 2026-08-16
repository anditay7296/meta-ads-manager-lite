import Link from "next/link";
import { notFound } from "next/navigation";
import { Topbar } from "@/components/app-shell/Topbar";
import { getAppSession } from "@/lib/auth/session";
import { getCopyEntry } from "@/lib/db/queries/copy";
import { EntryEditor } from "./EntryEditor";

export default async function CopyEntryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getAppSession();
  if (!session) return null;
  const { id } = await params;
  const data = await getCopyEntry({ orgId: session.orgId, entryId: id });
  if (!data) notFound();

  return (
    <>
      <Topbar
        title={data.entry.title}
        subtitle={
          <Link href="/copy" className="hover:text-zinc-900 dark:hover:text-zinc-100">
            ← Library
          </Link>
        }
      />
      <div className="flex flex-1 flex-col overflow-y-auto p-4 sm:p-8">
        <div className="mx-auto w-full max-w-3xl">
          <EntryEditor entry={data.entry} variants={data.variants} />
        </div>
      </div>
    </>
  );
}
