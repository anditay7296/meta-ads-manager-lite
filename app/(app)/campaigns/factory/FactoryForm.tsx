"use client";

import { useRef, useState, useTransition } from "react";
import { activateDrafts, runFactoryAction, type FactoryRunResult } from "./actions";
import { BulkLaunchForm } from "./BulkLaunchForm";
import { cn } from "@/lib/utils";
import { Sparkles, Play, Upload, X } from "lucide-react";

const SAMPLE = `[
  {
    "pain_point_slug": "low-confidence",
    "variation_number": 1,
    "image_url": "https://your-cdn.com/creative-1.jpg",
    "primary_text": "Tired of overthinking every post? Run ads on autopilot.",
    "headline": "Your AI ad operator",
    "description": "Set thresholds once, sleep through the night",
    "link_url": "https://yourfunnel.com",
    "call_to_action": "LEARN_MORE"
  },
  {
    "pain_point_slug": "low-confidence",
    "variation_number": 2,
    "post_id": "PAGEID_POSTID"
  }
]`;

type AdSetOption = { id: string; label: string; campaignId: string };
type CampaignOption = { id: string; label: string };
type PageOption = { id: string; label: string };

type CopyEntry = {
  id: string;
  title: string;
  painPointSlug: string | null;
  funnelStage: string | null;
  variants: Array<{
    variantNumber: number;
    primaryText: string;
    headline: string | null;
    description: string | null;
    callToAction: string | null;
  }>;
};

export function FactoryForm({
  adSets,
  campaigns,
  pages,
  defaultAdSetId,
  copyEntries = [],
}: {
  adSets: AdSetOption[];
  campaigns: CampaignOption[];
  pages: PageOption[];
  defaultAdSetId?: string;
  copyEntries?: CopyEntry[];
}) {
  const [mode, setMode] = useState<"bulk" | "advanced">("bulk");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<FactoryRunResult | null>(null);
  const [json, setJson] = useState<string>("");
  const [assetFiles, setAssetFiles] = useState<File[]>([]);
  const [selectedDrafts, setSelectedDrafts] = useState<Set<string>>(new Set());
  const [activatingResult, setActivatingResult] = useState<{
    ok: number;
    failed: number;
  } | null>(null);
  const assetInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    fd.set("json", json);
    // Append each chosen asset file under the same field name.
    for (const f of assetFiles) fd.append("assetFiles", f);
    startTransition(async () => {
      setActivatingResult(null);
      setSelectedDrafts(new Set());
      setResult(await runFactoryAction(fd));
    });
  };

  const addAssetFiles = (files: FileList | File[] | null) => {
    if (!files) return;
    const arr = Array.from(files).filter((f) => f.type.startsWith("image/"));
    setAssetFiles((prev) => {
      const merged = [...prev];
      const seen = new Set(prev.map((f) => f.name));
      for (const f of arr) if (!seen.has(f.name)) merged.push(f);
      return merged;
    });
  };
  const removeAssetFile = (name: string) =>
    setAssetFiles((prev) => prev.filter((f) => f.name !== name));

  const autofillImagesInOrder = () => {
    if (assetFiles.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(json || "[]");
    } catch {
      return;
    }
    const list: Record<string, unknown>[] = Array.isArray(parsed)
      ? (parsed as Record<string, unknown>[])
      : [parsed as Record<string, unknown>];
    let imgIdx = 0;
    const updated = list.map((spec) => {
      if (spec.image_url || spec.post_id) return spec;
      if (imgIdx < assetFiles.length) {
        const filename = assetFiles[imgIdx].name;
        imgIdx += 1;
        return { ...spec, image_url: `uploaded:${filename}` };
      }
      return spec;
    });
    setJson(JSON.stringify(updated, null, 2));
  };

  const importFromCopyEntry = (entry: CopyEntry) => {
    const slug =
      entry.painPointSlug ??
      entry.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    const newSpecs = entry.variants.map((v) => {
      const spec: Record<string, unknown> = {
        pain_point_slug: slug,
        variation_number: v.variantNumber,
        primary_text: v.primaryText,
      };
      if (v.headline) spec.headline = v.headline;
      if (v.description) spec.description = v.description;
      if (v.callToAction) spec.call_to_action = v.callToAction;
      // image_url left blank — operator fills in or uses uploaded:filename.
      return spec;
    });
    // Merge with existing JSON if it parses as an array.
    let existing: unknown[] = [];
    if (json.trim()) {
      try {
        const p = JSON.parse(json);
        if (Array.isArray(p)) existing = p;
        else existing = [p];
      } catch {
        existing = [];
      }
    }
    const combined = [...existing, ...newSpecs];
    setJson(JSON.stringify(combined, null, 2));
  };

  const handleFile = async (file: File) => {
    const text = await file.text();
    setJson(text);
  };

  const toggleDraft = (id: string) => {
    setSelectedDrafts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllDrafts = () => {
    if (result?.ok) {
      setSelectedDrafts(
        new Set(
          result.results
            .filter((r) => r.ok && r.draftAdId)
            .map((r) => r.draftAdId!),
        ),
      );
    }
  };

  const handleActivate = () => {
    const ids = Array.from(selectedDrafts);
    if (ids.length === 0) return;
    startTransition(async () => {
      const r = await activateDrafts(ids);
      setActivatingResult({ ok: r.ok, failed: r.failed });
      setSelectedDrafts(new Set());
    });
  };

  const successCount = result?.ok ? result.created : 0;
  const failedCount = result?.ok ? result.failed : 0;

  const modeBtn = (m: "bulk" | "advanced", label: string) => (
    <button
      type="button"
      onClick={() => setMode(m)}
      className={cn(
        "rounded-md px-3 py-1.5 text-xs font-medium",
        mode === m
          ? "bg-blue-600 text-white"
          : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700",
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        {modeBtn("bulk", "Bulk launch (1 file = 1 ad set)")}
        {modeBtn("advanced", "Advanced JSON (into one ad set)")}
      </div>

      {mode === "bulk" ? (
        <BulkLaunchForm
          adSets={adSets}
          campaigns={campaigns}
          pages={pages}
          defaultAdSetId={defaultAdSetId}
          copyEntries={copyEntries}
        />
      ) : (
        <>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">Ad set</span>
            <select
              name="adSetId"
              defaultValue={defaultAdSetId}
              required
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            >
              <option value="">— Select an ad set —</option>
              {adSets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">Page (creative source)</span>
            <select
              name="pageId"
              required
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            >
              <option value="">— Select a page —</option>
              {pages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium">
            Asset files (optional — drag-drop image files here)
          </span>
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              addAssetFiles(e.dataTransfer.files);
            }}
            onClick={() => assetInputRef.current?.click()}
            className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed border-zinc-300 bg-zinc-50 p-3 text-xs text-zinc-500 hover:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900"
          >
            <input
              ref={assetInputRef}
              type="file"
              multiple
              accept="image/*"
              className="hidden"
              onChange={(e) => addAssetFiles(e.currentTarget.files)}
            />
            <Upload className="h-3.5 w-3.5" />
            <span>
              Drop images here, or click to pick — referenced from specs as{" "}
              <code className="rounded bg-zinc-200 px-1 py-0.5 dark:bg-zinc-800">
                "image_url": "uploaded:&lt;filename&gt;"
              </code>
            </span>
          </div>
          {assetFiles.length > 0 ? (
            <>
              <ul className="mt-1 flex flex-wrap gap-1">
                {assetFiles.map((f) => (
                  <li
                    key={f.name}
                    className="flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-0.5 font-mono text-[10px] dark:border-zinc-700 dark:bg-zinc-950"
                  >
                    <span>{f.name}</span>
                    <span className="text-zinc-400">({Math.round(f.size / 1024)}KB)</span>
                    <button
                      type="button"
                      onClick={() => removeAssetFile(f.name)}
                      className="rounded p-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      aria-label="Remove"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={autofillImagesInOrder}
                className="mt-1 w-fit text-[11px] text-blue-600 underline-offset-2 hover:underline"
              >
                Auto-fill image_url into specs (in upload order)
              </button>
            </>
          ) : null}
        </div>

        {copyEntries.length > 0 ? (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium">
              Import from copy library (optional)
            </span>
            <div className="flex items-center gap-2">
              <select
                onChange={(e) => {
                  const id = e.currentTarget.value;
                  if (!id) return;
                  const entry = copyEntries.find((c) => c.id === id);
                  if (!entry) return;
                  importFromCopyEntry(entry);
                  e.currentTarget.value = "";
                }}
                defaultValue=""
                className="flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950"
              >
                <option value="">— Pick a copy entry to inject specs —</option>
                {copyEntries
                  .filter((c) => c.variants.length > 0)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title} ({c.variants.length} variants
                      {c.painPointSlug ? ` · ${c.painPointSlug}` : ""}
                      {c.funnelStage ? ` · ${c.funnelStage}` : ""})
                    </option>
                  ))}
              </select>
            </div>
            <span className="text-[10px] text-zinc-400">
              Appends N specs (one per variant) to the JSON below. Leaves
              image_url blank — drop matching images above with{" "}
              <code>uploaded:{"<filename>"}</code>, or paste public URLs.
            </span>
          </div>
        ) : null}

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">
            Variation specs (JSON array or single object)
          </span>
          <textarea
            value={json}
            onChange={(e) => setJson(e.target.value)}
            rows={10}
            placeholder={SAMPLE}
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-950"
          />
          <div className="flex items-center gap-2">
            <input
              type="file"
              accept="application/json,.json"
              onChange={(e) => {
                const f = e.currentTarget.files?.[0];
                if (f) handleFile(f);
              }}
              className="text-[11px] file:mr-2 file:rounded-md file:border-0 file:bg-zinc-100 file:px-2 file:py-1 file:text-[11px] file:font-medium file:text-zinc-700 dark:file:bg-zinc-800 dark:file:text-zinc-200"
            />
            <button
              type="button"
              onClick={() => setJson(SAMPLE)}
              className="text-[11px] text-zinc-500 underline-offset-2 hover:text-zinc-700 hover:underline dark:hover:text-zinc-300"
            >
              Insert sample
            </button>
          </div>
        </label>
        <button
          type="submit"
          disabled={pending || !json.trim()}
          className="inline-flex w-fit items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          <Sparkles className="h-3.5 w-3.5" />
          {pending && !result ? "Running…" : "Create paused drafts"}
        </button>
      </form>

      {result && !result.ok ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {result.message}
        </div>
      ) : null}

      {result?.ok ? (
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">
              Result: {successCount} created
              {failedCount ? ` · ${failedCount} failed` : ""}
            </h3>
            {successCount > 0 ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={selectAllDrafts}
                  className="text-[11px] text-zinc-500 underline-offset-2 hover:text-zinc-700 hover:underline"
                >
                  Select all OK
                </button>
                <button
                  type="button"
                  disabled={pending || selectedDrafts.size === 0}
                  onClick={handleActivate}
                  className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  <Play className="h-3 w-3" />
                  Activate {selectedDrafts.size || ""} selected
                </button>
              </div>
            ) : null}
          </div>
          {activatingResult ? (
            <p className="mt-2 text-xs text-emerald-600">
              Activated {activatingResult.ok} ads
              {activatingResult.failed
                ? ` · ${activatingResult.failed} failed`
                : ""}
              .
            </p>
          ) : null}
          <table className="mt-4 w-full text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="py-1 w-6" />
                <th className="py-1">Ad name</th>
                <th className="py-1">Status</th>
                <th className="py-1">Meta IDs / Error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {result.results.map((r, i) => {
                const name = `variation-${r.spec.pain_point_slug}-${r.spec.variation_number}`;
                const isSelected = r.draftAdId
                  ? selectedDrafts.has(r.draftAdId)
                  : false;
                return (
                  <tr key={i}>
                    <td className="py-1.5">
                      {r.ok && r.draftAdId ? (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleDraft(r.draftAdId!)}
                        />
                      ) : null}
                    </td>
                    <td className="py-1.5 font-mono text-[11px]">{name}</td>
                    <td className="py-1.5">
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider",
                          r.ok
                            ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                            : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
                        )}
                      >
                        {r.ok ? "Created" : "Failed"}
                      </span>
                    </td>
                    <td className="py-1.5 font-mono text-[10px] text-zinc-500">
                      {r.ok
                        ? `ad ${r.metaAdId} · creative ${r.metaCreativeId}`
                        : r.error}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
        </>
      )}
    </div>
  );
}
