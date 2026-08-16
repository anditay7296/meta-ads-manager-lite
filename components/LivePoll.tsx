"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-fetches the surrounding server component every `intervalSeconds` so
 * in-flight job progress (clone jobs, factory runs) advances without a manual
 * reload. The Next App Router diffs the rendered HTML, so this is cheap —
 * only the parts of the tree that actually changed re-paint.
 *
 * Skips polling when the tab is hidden to avoid hammering the server while
 * nobody is looking.
 */
export function LivePoll({ intervalSeconds = 20 }: { intervalSeconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const id = window.setInterval(tick, intervalSeconds * 1000);
    return () => window.clearInterval(id);
  }, [router, intervalSeconds]);
  return null;
}
