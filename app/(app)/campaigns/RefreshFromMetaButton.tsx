"use client";

import { useActionState } from "react";
import { RefreshCw } from "lucide-react";
import { refreshFromMetaAction, type RefreshState } from "./actions";
import { cn } from "@/lib/utils";

const initial: RefreshState = { ok: false, message: "" };

export function RefreshFromMetaButton({
  range,
}: {
  range: "today" | "yesterday" | "last_7d" | "last_30d" | "max";
}) {
  const [state, action, pending] = useActionState(refreshFromMetaAction, initial);
  return (
    <div className="flex items-center gap-2">
      {state.message ? (
        <span
          className={cn(
            "text-[11px]",
            state.ok ? "text-emerald-600" : "text-red-600",
          )}
        >
          {state.message}
        </span>
      ) : null}
      <form action={action}>
        <input type="hidden" name="range" value={range} />
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", pending && "animate-spin")} />
          {pending ? "Syncing…" : "Refresh from Meta"}
        </button>
      </form>
    </div>
  );
}
