"use client";

import { useState, useTransition } from "react";
import { Check, Copy, Pencil, Trash2, X } from "lucide-react";
import {
  addVariantAction,
  deleteCopyEntryAction,
  deleteVariantAction,
  updateCopyEntryAction,
  updateVariantAction,
} from "../actions";
import type { CopyEntryRow, CopyVariantRow } from "@/lib/db/queries/copy";

export function EntryEditor({
  entry,
  variants,
}: {
  entry: CopyEntryRow;
  variants: CopyVariantRow[];
}) {
  const [pending, startTransition] = useTransition();
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function copyVariant(v: CopyVariantRow) {
    try {
      // Clipboard API can hang on a permission prompt — don't wait forever
      await Promise.race([
        navigator.clipboard.writeText(v.primaryText),
        new Promise((_, reject) => setTimeout(reject, 600)),
      ]);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = v.primaryText;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopiedId(v.id);
    setTimeout(() => setCopiedId((cur) => (cur === v.id ? null : cur)), 2000);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
        <h3 className="text-sm font-semibold">Entry metadata</h3>
        <form
          action={(fd) =>
            startTransition(async () => updateCopyEntryAction(entry.id, fd))
          }
          className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2"
        >
          <input
            name="title"
            required
            defaultValue={entry.title}
            placeholder="Title"
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm sm:col-span-2 dark:border-zinc-700 dark:bg-zinc-950"
          />
          <input
            name="painPointSlug"
            defaultValue={entry.painPointSlug ?? ""}
            placeholder="pain-point-slug"
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-950"
          />
          <input
            name="audience"
            defaultValue={entry.audience ?? ""}
            placeholder="Audience"
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-950"
          />
          <select
            name="funnelStage"
            defaultValue={entry.funnelStage ?? ""}
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
            defaultValue={(entry.tags ?? []).join(", ")}
            placeholder="tags, comma, separated"
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-950"
          />
          <textarea
            name="notes"
            defaultValue={entry.notes ?? ""}
            rows={2}
            placeholder="Notes"
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs sm:col-span-2 dark:border-zinc-700 dark:bg-zinc-950"
          />
          <div className="flex items-center justify-between sm:col-span-2">
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save metadata"}
            </button>
            <button
              type="submit"
              formAction={() =>
                startTransition(async () => deleteCopyEntryAction(entry.id))
              }
              disabled={pending}
              className="rounded-md border border-red-200 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900"
            >
              Delete entry
            </button>
          </div>
        </form>
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
        <h3 className="text-sm font-semibold">Variants ({variants.length})</h3>
        <p className="mt-1 text-xs text-zinc-500">
          Up to 4 per entry covers Meta's multi-text feature. The variation
          factory + agent draw from these.
        </p>
        <div className="mt-4 flex flex-col gap-3">
          {variants.map((v) => (
            <VariantCard
              key={v.id}
              variant={v}
              entryId={entry.id}
              pending={pending}
              copied={copiedId === v.id}
              onCopy={() => copyVariant(v)}
              startTransition={startTransition}
            />
          ))}
        </div>

        {variants.length < 4 ? (
          <form
            action={(fd) =>
              startTransition(async () => addVariantAction(entry.id, fd))
            }
            className="mt-4 flex flex-col gap-2 rounded-md border border-dashed border-zinc-300 p-3 dark:border-zinc-700"
          >
            <textarea
              name="primaryText"
              required
              rows={3}
              placeholder="Primary text (the body of the ad)"
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <input
                name="headline"
                placeholder="Headline (optional)"
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-950"
              />
              <input
                name="description"
                placeholder="Description (optional)"
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-950"
              />
              <input
                name="callToAction"
                placeholder="CTA (e.g. LEARN_MORE)"
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-950"
              />
            </div>
            <button
              type="submit"
              disabled={pending}
              className="w-fit rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Add variant
            </button>
          </form>
        ) : (
          <p className="mt-3 text-[11px] text-zinc-500">
            Maxed out at 4 variants — delete one to add another.
          </p>
        )}
      </div>
    </div>
  );
}

function VariantCard({
  variant: v,
  entryId,
  pending,
  copied,
  onCopy,
  startTransition,
}: {
  variant: CopyVariantRow;
  entryId: string;
  pending: boolean;
  copied: boolean;
  onCopy: () => void;
  startTransition: (cb: () => void) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <form
        action={(fd) =>
          startTransition(async () => {
            await updateVariantAction(v.id, entryId, fd);
            setEditing(false);
          })
        }
        className="flex flex-col gap-2 rounded-md border border-blue-200 p-3 dark:border-blue-900"
      >
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">
            Editing variant {v.variantNumber}
          </span>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            aria-label="Cancel editing"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
        <textarea
          name="primaryText"
          required
          rows={3}
          defaultValue={v.primaryText}
          placeholder="Primary text (the body of the ad)"
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <input
            name="headline"
            defaultValue={v.headline ?? ""}
            placeholder="Headline (optional)"
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-950"
          />
          <input
            name="description"
            defaultValue={v.description ?? ""}
            placeholder="Description (optional)"
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-950"
          />
          <input
            name="callToAction"
            defaultValue={v.callToAction ?? ""}
            placeholder="CTA (e.g. LEARN_MORE)"
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-950"
          />
        </div>
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={pending}
            className="w-fit rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save variant"}
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="text-xs text-zinc-500 hover:underline"
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="rounded-md border border-zinc-100 p-3 dark:border-zinc-800">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">
          Variant {v.variantNumber}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onCopy}
            className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            aria-label="Copy primary text"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 text-emerald-600" />
                <span className="text-emerald-600">Copied</span>
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" />
                Copy
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            aria-label="Edit variant"
          >
            <Pencil className="h-3 w-3" />
            Edit
          </button>
          <form
            action={() =>
              startTransition(async () => deleteVariantAction(v.id, entryId))
            }
          >
            <button
              type="submit"
              disabled={pending}
              className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-red-600 dark:hover:bg-zinc-800"
              aria-label="Delete variant"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </form>
        </div>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-sm">{v.primaryText}</p>
      {v.headline ? (
        <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
          <span className="font-medium">Headline:</span> {v.headline}
        </p>
      ) : null}
      {v.description ? (
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          <span className="font-medium">Description:</span> {v.description}
        </p>
      ) : null}
      {v.callToAction ? (
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          <span className="font-medium">CTA:</span> {v.callToAction}
        </p>
      ) : null}
    </div>
  );
}
