"use client";

import { useActionState } from "react";
import { createCopyEntryAction, type ActionState } from "./actions";

const initial: ActionState = { ok: false, message: "" };

export function CreateEntryForm() {
  const [state, action, pending] = useActionState(createCopyEntryAction, initial);
  return (
    <form action={action} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <input
        name="title"
        required
        placeholder="Entry title (e.g. Low confidence ↔ AI freedom)"
        className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm sm:col-span-2 dark:border-zinc-700 dark:bg-zinc-950"
      />
      <input
        name="painPointSlug"
        placeholder="pain-point-slug (lowercase-hyphen)"
        className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-950"
      />
      <input
        name="audience"
        placeholder="Audience (e.g. KL SMB owners 28-45)"
        className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-950"
      />
      <select
        name="funnelStage"
        defaultValue=""
        className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-950"
      >
        <option value="">— Funnel stage —</option>
        <option value="cold">cold</option>
        <option value="warm">warm</option>
        <option value="hot">hot</option>
        <option value="retention">retention</option>
      </select>
      <input
        name="tagsCsv"
        placeholder="tags, comma, separated"
        className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-950"
      />
      <textarea
        name="notes"
        rows={2}
        placeholder="Notes (briefing, context, anything that helps the agent or the next person)"
        className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs sm:col-span-2 dark:border-zinc-700 dark:bg-zinc-950"
      />
      <div className="flex items-center justify-between sm:col-span-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {pending ? "Creating…" : "Create entry"}
        </button>
        {state.message ? (
          <span className={state.ok ? "text-xs text-emerald-600" : "text-xs text-red-600"}>
            {state.message}
          </span>
        ) : null}
      </div>
    </form>
  );
}
