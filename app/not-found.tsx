import Link from "next/link";
import { Logo } from "@/components/app-shell/Logo";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-zinc-50 p-8 dark:bg-zinc-950">
      <Logo markClassName="h-12 w-auto" />
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="max-w-md text-center text-sm text-zinc-500">
        That page doesn't exist (or you don't have access). Sometimes a project
        was archived or a draft was deleted; the link above might be stale.
      </p>
      <div className="mt-2 flex gap-2">
        <Link
          href="/dashboard"
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Go to dashboard
        </Link>
        <Link
          href="/campaigns"
          className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
        >
          Go to campaigns
        </Link>
      </div>
    </div>
  );
}
