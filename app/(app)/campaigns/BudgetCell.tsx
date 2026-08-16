"use client";

import { useState, useRef, useTransition } from "react";
import { Pencil } from "lucide-react";
import { formatMyr } from "@/lib/utils";

export function BudgetCell({
  entityId,
  budgetCents,
  budgetKind,
  onSave,
}: {
  entityId: string;
  budgetCents: number | null;
  budgetKind: "daily" | "lifetime" | null;
  onSave: (
    id: string,
    cents: number,
    kind: "daily" | "lifetime",
  ) => Promise<{ ok: boolean; message?: string }>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const displayRm =
    budgetCents != null ? budgetCents / 100 : null;
  const suffix =
    budgetKind === "daily"
      ? "/day"
      : budgetKind === "lifetime"
        ? " lifetime"
        : "";

  function startEdit() {
    if (budgetCents == null || budgetKind == null) return;
    setValue((budgetCents / 100).toFixed(2));
    setError(null);
    setEditing(true);
    setTimeout(() => {
      inputRef.current?.select();
    }, 0);
  }

  function commit() {
    const rm = parseFloat(value.replace(/[^0-9.]/g, ""));
    if (!isFinite(rm) || rm <= 0) {
      setError("Enter a valid amount (RM)");
      return;
    }
    if (budgetKind == null) return;
    const cents = Math.round(rm * 100);
    startTransition(async () => {
      const r = await onSave(entityId, cents, budgetKind);
      if (r.ok) {
        setEditing(false);
        setError(null);
      } else {
        setError(r.message ?? "Failed to update");
      }
    });
  }

  if (editing) {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-zinc-500">RM</span>
          <input
            ref={inputRef}
            type="number"
            step="0.01"
            min="0.01"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setEditing(false);
            }}
            onBlur={commit}
            disabled={pending}
            className="w-24 rounded border border-blue-500 bg-white px-1.5 py-0.5 text-right text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:bg-zinc-900"
          />
        </div>
        {error && (
          <span className="text-[10px] text-red-500">{error}</span>
        )}
      </div>
    );
  }

  if (displayRm == null) {
    return <span className="text-zinc-400">—</span>;
  }

  return (
    <button
      type="button"
      onClick={startEdit}
      title="Click to edit budget"
      className="group flex items-center justify-end gap-1 whitespace-nowrap text-right"
    >
      {formatMyr(displayRm)}
      {suffix && (
        <span className="text-[10px] text-zinc-500">{suffix}</span>
      )}
      <Pencil className="h-2.5 w-2.5 text-zinc-300 opacity-0 transition-opacity group-hover:opacity-100 dark:text-zinc-600" />
    </button>
  );
}
