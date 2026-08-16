"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Play } from "lucide-react";
import { activateFactoryItems } from "../../actions";

type Item = {
  draftAdId: string;
  localAdSetId?: string;
  adSetName: string;
  fileName: string;
};

/**
 * Post-run review: tick the drafts worth launching, activate ad set + ad
 * together (both were created PAUSED by the factory-run job).
 */
export function ActivatePanel({ items }: { items: Item[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{ ok: number; failed: number } | null>(null);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const activate = () => {
    const picks = items.filter((i) => selected.has(i.draftAdId));
    if (picks.length === 0) return;
    startTransition(async () => {
      const r = await activateFactoryItems(
        picks.map((p) => ({ draftAdId: p.draftAdId, localAdSetId: p.localAdSetId })),
      );
      setResult({ ok: r.ok, failed: r.failed });
      setSelected(new Set());
      router.refresh();
    });
  };

  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-4 dark:border-emerald-900 dark:bg-emerald-950/20">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Review &amp; activate — {items.length} paused drafts ready
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSelected(new Set(items.map((i) => i.draftAdId)))}
            className="text-[11px] text-zinc-500 underline-offset-2 hover:underline"
          >
            Select all
          </button>
          <button
            type="button"
            disabled={pending || selected.size === 0}
            onClick={activate}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            <Play className="h-3 w-3" />
            {pending ? "Activating…" : `Activate ${selected.size || ""} selected (ad set + ad)`}
          </button>
        </div>
      </div>
      {result ? (
        <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-300">
          Activated {result.ok} draft{result.ok === 1 ? "" : "s"}
          {result.failed ? ` · ${result.failed} failed` : ""}.
        </p>
      ) : null}
      <ul className="mt-3 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((i) => (
          <li key={i.draftAdId}>
            <label className="flex cursor-pointer items-center gap-2 rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-xs dark:border-zinc-800 dark:bg-zinc-950">
              <input
                type="checkbox"
                checked={selected.has(i.draftAdId)}
                onChange={() => toggle(i.draftAdId)}
              />
              <span className="min-w-0">
                <span className="block truncate font-mono text-[11px]">{i.adSetName}</span>
                <span className="block truncate text-[10px] text-zinc-400">{i.fileName}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
