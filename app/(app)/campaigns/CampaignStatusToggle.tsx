"use client";

import { useTransition, useState } from "react";
import { toggleCampaignStatusAction } from "./actions";
import { cn } from "@/lib/utils";

export function CampaignStatusToggle({
  campaignId,
  isActive,
}: {
  campaignId: string;
  isActive: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useState(isActive);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        role="switch"
        aria-checked={optimistic}
        disabled={pending}
        onClick={() => {
          const next = !optimistic;
          setOptimistic(next);
          setError(null);
          startTransition(async () => {
            const r = await toggleCampaignStatusAction(
              campaignId,
              next ? "ACTIVE" : "PAUSED",
            );
            if (!r.ok) {
              setOptimistic(!next);
              setError(r.message ?? "Failed");
            }
          });
        }}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
          optimistic
            ? "bg-blue-600"
            : "bg-zinc-300 dark:bg-zinc-700",
        )}
        title={optimistic ? "Pause campaign" : "Resume campaign"}
      >
        <span
          className={cn(
            "inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform",
            optimistic ? "translate-x-5" : "translate-x-1",
          )}
        />
      </button>
      {error ? <span className="text-[10px] text-red-600">{error}</span> : null}
    </div>
  );
}
