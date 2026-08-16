"use client";

export function BulkActionBar({
  count,
  entityLabel,
  onPause,
  onResume,
  onClear,
  isPending,
}: {
  count: number;
  entityLabel: string;
  onPause: () => void;
  onResume: () => void;
  onClear: () => void;
  isPending: boolean;
}) {
  if (count === 0) return null;
  return (
    <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 flex items-center gap-3 rounded-full border border-zinc-700 bg-zinc-900 px-5 py-2.5 text-sm text-white shadow-2xl dark:border-zinc-600">
      <span className="font-medium tabular-nums">
        {count} {entityLabel}{count === 1 ? "" : "s"} selected
      </span>
      <div className="h-4 w-px bg-zinc-600" />
      <button
        type="button"
        disabled={isPending}
        onClick={onResume}
        className="rounded-full bg-blue-600 px-3.5 py-1 text-xs font-semibold hover:bg-blue-500 disabled:opacity-50 transition-colors"
      >
        Resume
      </button>
      <button
        type="button"
        disabled={isPending}
        onClick={onPause}
        className="rounded-full bg-zinc-700 px-3.5 py-1 text-xs font-semibold hover:bg-zinc-600 disabled:opacity-50 transition-colors"
      >
        Pause
      </button>
      <button
        type="button"
        onClick={onClear}
        disabled={isPending}
        title="Clear selection"
        className="ml-1 text-zinc-400 hover:text-white transition-colors disabled:opacity-50"
      >
        ✕
      </button>
    </div>
  );
}
