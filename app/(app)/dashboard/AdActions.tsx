"use client";

import { useTransition, useState } from "react";
import { Pause, Play } from "lucide-react";
import { setSingleAdStatus } from "./action-mutations";
import { cn } from "@/lib/utils";

export function AdQuickAction({
  adId,
  isPaused,
}: {
  adId: string;
  isPaused: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const nextStatus = isPaused ? "ACTIVE" : "PAUSED";
  const Icon = isPaused ? Play : Pause;

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const r = await setSingleAdStatus(adId, nextStatus);
            if (!r.ok) setError(r.message ?? "Failed");
          })
        }
        className={cn(
          "inline-flex h-6 w-6 items-center justify-center rounded-md border text-zinc-500 transition-colors disabled:opacity-50",
          isPaused
            ? "border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700 dark:border-emerald-900 dark:hover:bg-emerald-950"
            : "border-zinc-200 hover:bg-zinc-100 hover:text-zinc-700 dark:border-zinc-800 dark:hover:bg-zinc-800",
        )}
        title={isPaused ? "Resume ad" : "Pause ad"}
      >
        <Icon className="h-3 w-3" />
      </button>
      {error ? <span className="text-[10px] text-red-600">{error}</span> : null}
    </div>
  );
}
