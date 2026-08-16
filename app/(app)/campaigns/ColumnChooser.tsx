"use client";

import { useState, useRef, useEffect } from "react";
import { Settings2 } from "lucide-react";

export function ColumnChooser({
  columns,
  hidden,
  onToggle,
}: {
  columns: string[];
  hidden: Set<string>;
  onToggle: (col: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Choose columns"
        className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
          open
            ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
            : "border-zinc-300 bg-white text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400"
        }`}
      >
        <Settings2 className="h-3.5 w-3.5" />
        Columns
        {hidden.size > 0 && (
          <span className="rounded-full bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold text-white leading-none">
            {hidden.size}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-52 rounded-lg border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-800 dark:bg-zinc-950">
          <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
            Show / hide columns
          </p>
          {columns.map((col) => (
            <label
              key={col}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              <input
                type="checkbox"
                checked={!hidden.has(col)}
                onChange={() => onToggle(col)}
                className="h-3.5 w-3.5 accent-blue-600"
              />
              {col}
            </label>
          ))}
          {hidden.size > 0 && (
            <button
              type="button"
              onClick={() => columns.forEach((c) => hidden.has(c) && onToggle(c))}
              className="mt-1.5 w-full rounded px-2 py-1 text-left text-[10px] text-blue-600 hover:underline"
            >
              Show all columns
            </button>
          )}
        </div>
      )}
    </div>
  );
}
