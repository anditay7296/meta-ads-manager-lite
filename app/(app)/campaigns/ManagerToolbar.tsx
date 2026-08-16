"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition, useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { AdAccountFilter } from "./AdAccountFilter";
import { RefreshFromMetaButton } from "./RefreshFromMetaButton";

type RangePreset = "today" | "yesterday" | "last_7d" | "last_30d" | "max";

const RANGE_LABELS: Record<RangePreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last_7d: "Last 7d",
  last_30d: "Last 30d",
  max: "Maximum",
};

export function ManagerToolbar({
  range,
  search,
  activeOnly,
  adAccounts,
  adAccountOptions,
}: {
  range: RangePreset;
  search: string;
  activeOnly: boolean;
  adAccounts: string[];
  adAccountOptions: string[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [searchValue, setSearchValue] = useState(search);

  useEffect(() => {
    setSearchValue(search);
  }, [search]);

  function update(updates: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    startTransition(() => router.push(`/campaigns?${next.toString()}`));
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-white px-6 py-3 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center gap-1 rounded-md border border-zinc-200 p-0.5 text-xs dark:border-zinc-800">
        {(Object.keys(RANGE_LABELS) as RangePreset[]).map((r) => (
          <button
            key={r}
            type="button"
            disabled={pending}
            onClick={() => update({ range: r })}
            className={cn(
              "rounded px-2.5 py-1 transition-colors",
              range === r
                ? "bg-blue-600 text-white"
                : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100",
            )}
          >
            {RANGE_LABELS[r]}
          </button>
        ))}
      </div>

      {adAccountOptions.length > 0 && (
        <AdAccountFilter
          options={adAccountOptions}
          selected={adAccounts}
          disabled={pending}
          onChange={(next) =>
            update({ ad_account: next.length === 0 ? null : next.join(",") })
          }
        />
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          update({ q: searchValue });
        }}
        className="flex flex-1 items-center gap-2 min-w-[200px] max-w-md"
      >
        <input
          type="search"
          placeholder="Search campaigns…"
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-700 dark:bg-zinc-900"
        />
      </form>

      <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
        <input
          type="checkbox"
          checked={activeOnly}
          onChange={(e) =>
            update({ active: e.target.checked ? null : "0" })
          }
          className="h-3.5 w-3.5"
        />
        Active only
      </label>

      <div className="ml-auto">
        <RefreshFromMetaButton range={range} />
      </div>
    </div>
  );
}
