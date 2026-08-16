import Link from "next/link";
import { formatMyr, formatNumber, cn } from "@/lib/utils";
import { adStatus } from "@/lib/dashboard/status";
import type { AdCardData } from "@/lib/db/queries/dashboard";

const STATUS_STYLE: Record<
  ReturnType<typeof adStatus>,
  { dot: string; pill: string; label: string; emoji: string; card: string }
> = {
  paused: {
    dot: "bg-zinc-400",
    pill: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
    label: "Paused",
    emoji: "⚫",
    card: "border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-500",
  },
  red: {
    dot: "bg-red-500",
    pill: "bg-red-100 text-red-700 font-semibold dark:bg-red-950 dark:text-red-300",
    label: "☠︎ Kill",
    emoji: "🔴",
    card: "border-red-200 bg-red-50 border-l-4 border-l-red-500 dark:border-red-900 dark:bg-red-950/30 dark:border-l-red-500",
  },
  yellow: {
    dot: "bg-amber-500",
    pill: "bg-amber-100 text-amber-800 font-semibold dark:bg-amber-950 dark:text-amber-300",
    label: "⚠︎ At risk",
    emoji: "🟡",
    card: "border-amber-200 bg-amber-50 border-l-4 border-l-amber-500 dark:border-amber-900 dark:bg-amber-950/30 dark:border-l-amber-500",
  },
  green: {
    dot: "bg-emerald-500",
    pill: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
    label: "Keep",
    emoji: "🟢",
    card: "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950",
  },
  neutral: {
    dot: "bg-zinc-300",
    pill: "bg-zinc-50 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400",
    label: "No spend",
    emoji: "⚪",
    card: "border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-500",
  },
};

export function AdCard({ ad }: { ad: AdCardData }) {
  const status = adStatus(ad);
  const style = STATUS_STYLE[status];
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-3 text-xs shadow-sm transition-colors hover:shadow-md",
        style.card,
      )}
    >
      <div className="flex items-center gap-1.5">
        <span aria-hidden="true" className="text-xs leading-none">
          {style.emoji}
        </span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider",
            style.pill,
          )}
        >
          {style.label}
        </span>
      </div>
      <Link
        href={`/dashboard/ads/${ad.id}`}
        className="line-clamp-2 text-sm font-medium leading-snug hover:underline"
        title={ad.name}
      >
        {ad.name}
      </Link>
      <div className="text-[10px] text-zinc-500" title={ad.campaignName}>
        <span className="line-clamp-1">{ad.campaignName}</span>
      </div>
      <div className="mt-1 grid grid-cols-3 gap-1">
        <Metric label="Spend" value={formatMyr(ad.spend)} />
        <Metric label="Results" value={formatNumber(ad.results)} />
        <Metric
          label="CPR"
          value={ad.costPerResult !== null ? formatMyr(ad.costPerResult) : "—"}
        />
      </div>
      <div className="grid grid-cols-3 gap-1 border-t border-zinc-100 pt-2 dark:border-zinc-800">
        <Metric
          label="ROAS"
          value={ad.purchaseRoas ? `${ad.purchaseRoas.toFixed(2)}x` : "—"}
        />
        <Metric
          label="CTR"
          value={ad.ctr ? `${ad.ctr.toFixed(2)}%` : "—"}
        />
        <Metric label="Clicks" value={formatNumber(ad.clicks)} />
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[9px] uppercase tracking-wider text-zinc-400">
        {label}
      </span>
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </div>
  );
}
