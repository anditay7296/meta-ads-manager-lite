"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Shield, ShieldOff } from "lucide-react";
import { toggleCampaignAutoPauseExemptAction } from "./actions";
import { cn } from "@/lib/utils";

/**
 * Per-campaign auto-pause exemption. ON = rules engine skips every ad inside
 * this campaign. CPL-spike alerts still fire from AI Guard (inline inside
 * the 14:00 KL midday-status cron), so the operator still hears about issues
 * in /telegram and decides manually whether to pause.
 *
 * Click opens a small popover for an optional reason note, then confirm.
 * Logged in the Decision Journal.
 */
export function AutoPauseExemptToggle({
  campaignId,
  isExempt,
  currentReason,
}: {
  campaignId: string;
  isExempt: boolean;
  currentReason: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useState(isExempt);
  const [reason, setReason] = useState(currentReason ?? "");
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setOptimistic(isExempt);
    setReason(currentReason ?? "");
  }, [isExempt, currentReason]);

  useEffect(() => {
    if (!popoverOpen) return;
    function onDoc(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setPopoverOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [popoverOpen]);

  function onClickPill() {
    setError(null);
    if (optimistic) {
      // Turning OFF — confirm via popover too, but with empty reason field.
      setPopoverOpen(true);
    } else {
      setPopoverOpen(true);
    }
  }

  function confirmToggle() {
    const next = !optimistic;
    setError(null);
    setPopoverOpen(false);
    setOptimistic(next);
    startTransition(async () => {
      const r = await toggleCampaignAutoPauseExemptAction(
        campaignId,
        next,
        next ? reason : undefined,
      );
      if (!r.ok) {
        setOptimistic(!next);
        setError(r.message ?? "Failed");
      }
    });
  }

  return (
    <div className="relative inline-flex items-center gap-1">
      <button
        type="button"
        onClick={onClickPill}
        disabled={pending}
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors disabled:opacity-50",
          optimistic
            ? "bg-amber-100 text-amber-800 hover:bg-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:hover:bg-amber-900"
            : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700",
        )}
        title={
          optimistic
            ? `Rules + AI Guard skip this campaign${currentReason ? ` (${currentReason})` : ""}. Click to turn off.`
            : "Click to exempt this campaign from auto-pause rules"
        }
      >
        {optimistic ? (
          <Shield className="h-2.5 w-2.5" aria-hidden="true" />
        ) : (
          <ShieldOff className="h-2.5 w-2.5" aria-hidden="true" />
        )}
        {optimistic ? "Exempt" : "Auto-pause on"}
      </button>

      {popoverOpen && (
        <div
          ref={popoverRef}
          className="absolute left-0 top-7 z-30 w-72 rounded-md border border-zinc-200 bg-white p-3 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
        >
          {!optimistic ? (
            <>
              <p className="mb-2 text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">
                Skip every automated pause rule and the agent&apos;s pause
                proposals for this campaign. CPL-spike alerts will still fire
                in <span className="font-mono">/telegram</span>.
              </p>
              <label className="mb-1 block text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                Reason (optional)
              </label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder="e.g. testing new audience — let it run a week"
                className="w-full rounded border border-zinc-300 bg-white p-1.5 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              />
              <div className="mt-2 flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setPopoverOpen(false)}
                  className="rounded px-2 py-1 text-[11px] text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmToggle}
                  className="rounded bg-amber-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-amber-700"
                >
                  Mark exempt
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="mb-2 text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">
                Turn off auto-pause exemption? Rules and the agent will pause
                ads in this campaign again when they hit thresholds.
              </p>
              {currentReason && (
                <p className="mb-2 rounded bg-zinc-50 p-2 text-[11px] text-zinc-500 dark:bg-zinc-950 dark:text-zinc-400">
                  Current reason: {currentReason}
                </p>
              )}
              <div className="mt-1 flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setPopoverOpen(false)}
                  className="rounded px-2 py-1 text-[11px] text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmToggle}
                  className="rounded bg-zinc-700 px-2 py-1 text-[11px] font-medium text-white hover:bg-zinc-800 dark:bg-zinc-600 dark:hover:bg-zinc-500"
                >
                  Turn off
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {error && (
        <span className="text-[10px] text-red-600" title={error}>
          !
        </span>
      )}
    </div>
  );
}
