import { Sparkles } from "lucide-react";

export function Topbar({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-zinc-200 bg-white px-4 sm:px-6 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex min-w-0 flex-col leading-tight">
        <h1 className="truncate text-sm font-semibold">{title}</h1>
        {subtitle ? (
          <span className="truncate text-[11px] text-zinc-500">{subtitle}</span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {actions}
        <button
          type="button"
          className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Ask agent
        </button>
      </div>
    </div>
  );
}
