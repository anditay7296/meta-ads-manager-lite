"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition, useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { AdAccountFilter } from "../AdAccountFilter";
import { RefreshFromMetaButton } from "../RefreshFromMetaButton";

type RangePreset = "today" | "yesterday" | "last_7d" | "last_30d" | "max";

const RANGE_LABELS: Record<RangePreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last_7d: "Last 7d",
  last_30d: "Last 30d",
  max: "Maximum",
};

export function AdSetsToolbar({
  range,
  search,
  adAccounts,
  adAccountOptions,
  campaign,
  campaignOptions,
  activeCampaignsOnly,
}: {
  range: RangePreset;
  search: string;
  adAccounts: string[];
  adAccountOptions: string[];
  campaign: string;
  campaignOptions: string[];
  activeCampaignsOnly: boolean;
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
    startTransition(() =>
      router.push(`/campaigns/adsets?${next.toString()}`),
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-white px-6 py-3 dark:border-zinc-800 dark:bg-zinc-950">
      {/* Date range presets */}
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

      {/* Ad account filter — narrows the campaign dropdown too. CSV-encoded
          in the `?ad_account=` URL param so multiple accounts can be selected. */}
      {adAccountOptions.length > 0 && (
        <AdAccountFilter
          options={adAccountOptions}
          selected={adAccounts}
          disabled={pending}
          onChange={(next) =>
            // Reset campaign filter when the ad account selection changes —
            // the current campaign may not exist in the new account set.
            update({
              ad_account: next.length === 0 ? null : next.join(","),
              campaign: null,
            })
          }
        />
      )}

      {/* Campaign filter */}
      {campaignOptions.length > 0 && (
        <select
          value={campaign}
          disabled={pending}
          onChange={(e) => update({ campaign: e.target.value || null })}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">All campaigns</option>
          {campaignOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      )}

      {/* Search */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          update({ q: searchValue });
        }}
        className="flex min-w-[200px] max-w-md flex-1 items-center gap-2"
      >
        <input
          type="search"
          placeholder="Search ad sets…"
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-700 dark:bg-zinc-900"
        />
      </form>

      {/* Active campaigns only toggle */}
      <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
        <input
          type="checkbox"
          checked={activeCampaignsOnly}
          onChange={(e) =>
            // Default is ON; only set ?active_campaigns=0 when turning off.
            update({ active_campaigns: e.target.checked ? null : "0" })
          }
          className="h-3.5 w-3.5"
        />
        Active campaigns only
      </label>

      <div className="ml-auto">
        <RefreshFromMetaButton range={range} />
      </div>
    </div>
  );
}
