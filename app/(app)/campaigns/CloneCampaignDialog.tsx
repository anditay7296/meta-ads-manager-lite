"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { X, Copy, ArrowRight, AlertCircle } from "lucide-react";
import type { CampaignRow, CampaignsByAccount } from "@/lib/db/queries/manager";
import { cloneCampaignToAccountAction } from "./actions";

type Props = {
  campaign: CampaignRow;
  groups: CampaignsByAccount[];
  onClose: () => void;
};

/**
 * Kicks off a durable cross-account campaign clone (every live ad set → the
 * same-named campaign in another ad account) via `cloneCampaignToAccountAction`
 * → the `clone-campaign-to-account` Inngest job. On success it routes to the
 * /campaigns/clone-jobs/[jobId] progress page, so the operator can close the
 * browser while it runs.
 */
export function CloneCampaignDialog({ campaign, groups, onClose }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [destAccountId, setDestAccountId] = useState("");

  const sourceAccountId = useMemo(
    () => groups.find((g) => g.campaigns.some((c) => c.id === campaign.id))?.adAccountId,
    [groups, campaign.id],
  );

  // Every OTHER ad account + whether it has a same-named campaign to clone into.
  const destOptions = useMemo(
    () =>
      groups
        .filter((g) => g.adAccountId !== sourceAccountId)
        .map((g) => ({
          adAccountId: g.adAccountId,
          adAccountName: g.adAccountName,
          // Skip archived twins: the server never clones into one (it creates
          // a fresh PAUSED campaign instead), so offering an archived match
          // here would promise the wrong behavior.
          match:
            g.campaigns.find(
              (c) => c.name === campaign.name && c.status !== "ARCHIVED",
            ) ?? null,
        })),
    [groups, sourceAccountId, campaign.name],
  );

  const selected = destOptions.find((d) => d.adAccountId === destAccountId) ?? null;

  function submit() {
    if (!selected) return;
    setError(null);
    startTransition(async () => {
      const r = await cloneCampaignToAccountAction(
        campaign.id,
        selected.match
          ? { campaignId: selected.match.id }
          : { adAccountId: selected.adAccountId },
      );
      if (r.ok && r.jobId) router.push(`/campaigns/clone-jobs/${r.jobId}`);
      else setError(r.message ?? "Failed to start clone.");
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900 dark:text-zinc-100">
            <Copy className="h-4 w-4" /> Clone campaign → another account
          </h2>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
          Clones every <span className="font-medium">live (active + paused)</span> ad set of this campaign into the
          same-named campaign in another ad account. Runs in the background — you can close the browser.
        </p>

        <div className="mt-4 rounded-lg bg-zinc-50 p-3 text-sm dark:bg-zinc-900">
          <div className="text-xs uppercase tracking-wide text-zinc-400">Source</div>
          <div className="mt-0.5 font-medium text-zinc-900 dark:text-zinc-100">{campaign.name}</div>
        </div>

        <div className="mt-3 flex items-center justify-center text-zinc-400">
          <ArrowRight className="h-4 w-4" />
        </div>

        <label className="mt-1 block text-xs uppercase tracking-wide text-zinc-400">Destination account</label>
        <select
          value={destAccountId}
          onChange={(e) => setDestAccountId(e.target.value)}
          className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">Select an account…</option>
          {destOptions.map((d) => (
            <option key={d.adAccountId} value={d.adAccountId}>
              {d.adAccountName} {d.match ? "✓ same-named campaign" : "— no matching campaign"}
            </option>
          ))}
        </select>

        {selected && !selected.match && (
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-blue-50 p-3 text-sm text-blue-800 dark:bg-blue-950/40 dark:text-blue-300">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              No campaign named “{campaign.name}” in {selected.adAccountName} yet — it will be created automatically
              (paused, mirroring the source’s objective, budget and bid strategy) before the ad sets are cloned.
            </span>
          </div>
        )}

        {error && (
          <div className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={pending || !selected}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {pending
              ? "Starting…"
              : selected && !selected.match
                ? "Create campaign + clone ad sets"
                : "Clone ad sets"}
          </button>
        </div>
      </div>
    </div>
  );
}
