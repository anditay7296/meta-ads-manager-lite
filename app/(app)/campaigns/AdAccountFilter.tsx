"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = {
  options: string[];
  selected: string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
};

export function AdAccountFilter({
  options,
  selected,
  disabled,
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const selectedSet = new Set(selected);
  const label =
    selected.length === 0
      ? "All ad accounts"
      : selected.length === 1
        ? selected[0]
        : `${selected.length} ad accounts`;

  function toggle(name: string) {
    onChange(
      selectedSet.has(name)
        ? selected.filter((s) => s !== name)
        : [...selected, name],
    );
  }

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
      >
        <span className="max-w-[180px] truncate">{label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 min-w-[220px] overflow-hidden rounded-md border border-zinc-200 bg-white py-1 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <button
            type="button"
            onClick={() => onChange([])}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800",
              selected.length === 0 && "font-medium text-blue-600",
            )}
          >
            <span className="flex h-3.5 w-3.5 items-center justify-center">
              {selected.length === 0 && <Check className="h-3.5 w-3.5" />}
            </span>
            <span>All ad accounts</span>
          </button>
          <div className="my-1 h-px bg-zinc-100 dark:bg-zinc-800" />
          {options.map((opt) => {
            const checked = selectedSet.has(opt);
            return (
              <button
                key={opt}
                type="button"
                onClick={() => toggle(opt)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800",
                  checked && "font-medium text-blue-600",
                )}
              >
                <span
                  className={cn(
                    "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
                    checked
                      ? "border-blue-600 bg-blue-600 text-white"
                      : "border-zinc-300 dark:border-zinc-600",
                  )}
                >
                  {checked && <Check className="h-3 w-3" />}
                </span>
                <span className="truncate">{opt}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
