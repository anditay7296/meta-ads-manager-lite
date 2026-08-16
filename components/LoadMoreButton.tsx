"use client";

import { useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";

/**
 * Raises a capped grid's card count by rewriting the `?n=` searchParam.
 * The page stays a server component: the RSC re-render appends cards
 * because the backing query slices after a stable sort, so existing card
 * DOM nodes (and the scroll position, via `scroll: false`) are preserved.
 * `replace` keeps Back as "leave the page" instead of stepping through
 * every load. Used by /creatives and /dashboard.
 */
export function LoadMoreButton({
  shown,
  total,
  step,
}: {
  shown: number;
  total: number;
  step: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const loadMore = () => {
    const params = new URLSearchParams(searchParams);
    params.set("n", String(shown + step));
    startTransition(() => {
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    });
  };

  return (
    <div className="flex justify-center px-6 pb-10">
      <button
        type="button"
        onClick={loadMore}
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-4 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"
      >
        {pending ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading…
          </>
        ) : (
          `Load more (${shown} of ${total})`
        )}
      </button>
    </div>
  );
}
