"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@supabase/supabase-js";
import { prepareFactoryUploadsAction, queueFactoryRunAction } from "./actions";
import { Rocket, Upload, X, Plus, Trash2 } from "lucide-react";

const CTA_OPTIONS = [
  "LEARN_MORE",
  "SHOP_NOW",
  "SIGN_UP",
  "GET_OFFER",
  "BOOK_TRAVEL",
  "DOWNLOAD",
  "CONTACT_US",
  "SUBSCRIBE",
  "MESSAGE_PAGE",
  "WHATSAPP_MESSAGE",
] as const;

const MAX_BYTES = 50_485_760; // mirror the post-assets bucket limit
const MAX_FILES = 60;
const ACCEPTED = (f: File) =>
  f.type.startsWith("image/") || f.type === "video/mp4" || f.type === "video/quicktime";

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

type Variation = { primaryText: string; headline: string; description: string };

function defaultSlug() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `batch-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/**
 * Bulk mode: drop N images+videos, pick a template ad set + shared copy set,
 * submit once. Files upload straight from the browser to Supabase via signed
 * upload URLs (they'd blow the server-action body limit otherwise), then a
 * durable Inngest job creates one PAUSED ad set + one PAUSED ad per file.
 */
export function BulkLaunchForm({
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
  const router = useRouter();
  const [templateAdSetId, setTemplateAdSetId] = useState(defaultAdSetId ?? "");
  const [campaignId, setCampaignId] = useState("");
  const [pageId, setPageId] = useState("");
  const [batchSlug, setBatchSlug] = useState(defaultSlug());
  const [linkUrl, setLinkUrl] = useState("");
  const [cta, setCta] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [variations, setVariations] = useState<Variation[]>([
    { primaryText: "", headline: "", description: "" },
  ]);
  const [phase, setPhase] = useState<"idle" | "uploading" | "queueing">("idle");
  const [uploadedCount, setUploadedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const templateCampaignId = useMemo(
    () => adSets.find((s) => s.id === templateAdSetId)?.campaignId ?? "",
    [adSets, templateAdSetId],
  );
  const effectiveCampaignId = campaignId || templateCampaignId;

  const imageCount = files.filter((f) => f.type.startsWith("image/")).length;
  const videoCount = files.length - imageCount;
  const filledVariations = variations.filter((v) => v.primaryText.trim().length > 0);

  const addFiles = (list: FileList | File[] | null) => {
    if (!list) return;
    setError(null);
    const accepted: File[] = [];
    for (const f of Array.from(list)) {
      if (!ACCEPTED(f)) {
        setError(`"${f.name}" skipped — only images, MP4, or MOV.`);
        continue;
      }
      if (f.size > MAX_BYTES) {
        setError(`"${f.name}" skipped — over the 50MB limit.`);
        continue;
      }
      accepted.push(f);
    }
    setFiles((prev) => {
      const merged = [...prev];
      const seen = new Set(prev.map((f) => f.name));
      for (const f of accepted) if (!seen.has(f.name)) merged.push(f);
      return merged.slice(0, MAX_FILES);
    });
  };

  const setVariation = (i: number, patch: Partial<Variation>) =>
    setVariations((prev) => prev.map((v, j) => (j === i ? { ...v, ...patch } : v)));

  const importCopyEntry = (entry: CopyEntry) => {
    const vars = entry.variants.slice(0, 4).map((v) => ({
      primaryText: v.primaryText,
      headline: v.headline ?? "",
      description: v.description ?? "",
    }));
    if (vars.length > 0) setVariations(vars);
    const firstCta = entry.variants.find((v) => v.callToAction)?.callToAction;
    if (firstCta && (CTA_OPTIONS as readonly string[]).includes(firstCta)) setCta(firstCta);
  };

  const canSubmit =
    phase === "idle" &&
    templateAdSetId &&
    pageId &&
    files.length > 0 &&
    filledVariations.length > 0 &&
    /^[a-z0-9-]+$/.test(batchSlug);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setError(null);
    setPhase("uploading");
    setUploadedCount(0);
    try {
      const prep = await prepareFactoryUploadsAction(
        files.map((f) => ({ name: f.name, type: f.type, size: f.size })),
      );
      if (!prep.ok) throw new Error(prep.message);

      const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        { auth: { persistSession: false } },
      );
      const byName = new Map(prep.uploads.map((u) => [u.fileName, u]));
      // Modest concurrency — 3 parallel PUTs keeps big video batches moving
      // without saturating the uplink.
      const queue = [...files];
      let done = 0;
      const worker = async () => {
        for (;;) {
          const f = queue.shift();
          if (!f) return;
          const u = byName.get(f.name);
          if (!u) throw new Error(`No signed upload for "${f.name}"`);
          const { error: upErr } = await supabase.storage
            .from("post-assets")
            .uploadToSignedUrl(u.path, u.token, f, { contentType: f.type });
          if (upErr) throw new Error(`Upload failed for "${f.name}": ${upErr.message}`);
          done += 1;
          setUploadedCount(done);
        }
      };
      await Promise.all(Array.from({ length: 3 }, worker));

      setPhase("queueing");
      const res = await queueFactoryRunAction({
        templateAdSetId,
        campaignId: effectiveCampaignId || undefined,
        pageId,
        batchSlug,
        linkUrl: linkUrl.trim() || undefined,
        callToAction: (cta || undefined) as never,
        copySet: filledVariations.map((v) => ({
          primaryText: v.primaryText.trim(),
          headline: v.headline.trim() || undefined,
          description: v.description.trim() || undefined,
        })),
        assets: files.map((f) => ({
          fileName: f.name,
          publicUrl: byName.get(f.name)!.publicUrl,
          kind: f.type.startsWith("image/") ? ("image" as const) : ("video" as const),
        })),
      });
      if (!res.ok || !res.runId) throw new Error(res.message ?? "Could not queue the run");
      router.push(`/campaigns/factory/runs/${res.runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
    }
  };

  const inputCls =
    "rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950";

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">Template ad set (targeting + budget source)</span>
          <select
            value={templateAdSetId}
            onChange={(e) => {
              setTemplateAdSetId(e.target.value);
              setCampaignId(""); // re-default destination to the template's campaign
            }}
            className={inputCls}
          >
            <option value="">— Select the ad set to copy settings from —</option>
            {adSets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">Destination campaign</span>
          <select
            value={effectiveCampaignId}
            onChange={(e) => setCampaignId(e.target.value)}
            disabled={!templateAdSetId}
            className={inputCls}
          >
            <option value="">— Pick a template ad set first —</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">Page (creative source)</span>
          <select value={pageId} onChange={(e) => setPageId(e.target.value)} className={inputCls}>
            <option value="">— Select a page —</option>
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">Batch slug (names the new ad sets + ads)</span>
          <input
            value={batchSlug}
            onChange={(e) => setBatchSlug(e.target.value)}
            placeholder="batch-20260728"
            className={`${inputCls} font-mono`}
          />
        </label>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium">
          Creatives — each file becomes its OWN new ad set (copied from the template) with 1 ad
        </span>
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            addFiles(e.dataTransfer.files);
          }}
          onClick={() => fileInputRef.current?.click()}
          className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed border-zinc-300 bg-zinc-50 p-5 text-xs text-zinc-500 hover:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900"
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,video/mp4,video/quicktime"
            className="hidden"
            onChange={(e) => addFiles(e.currentTarget.files)}
          />
          <Upload className="h-4 w-4" />
          <span>Drop up to {MAX_FILES} images / MP4 / MOV here (max 50MB each), or click to pick</span>
        </div>
        {files.length > 0 ? (
          <>
            <p className="text-[11px] text-zinc-500">
              {files.length} files — {imageCount} images · {videoCount} videos
            </p>
            <ul className="flex max-h-40 flex-wrap gap-1 overflow-y-auto">
              {files.map((f) => (
                <li
                  key={f.name}
                  className="flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-0.5 font-mono text-[10px] dark:border-zinc-700 dark:bg-zinc-950"
                >
                  <span className="max-w-48 truncate">{f.name}</span>
                  <span className="text-zinc-400">({Math.round(f.size / 1024)}KB)</span>
                  <button
                    type="button"
                    onClick={() => setFiles((prev) => prev.filter((x) => x.name !== f.name))}
                    className="rounded p-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    aria-label="Remove"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium">
            Copy variations (1–4, paired round-robin across all files)
          </span>
          {copyEntries.length > 0 ? (
            <select
              onChange={(e) => {
                const entry = copyEntries.find((c) => c.id === e.currentTarget.value);
                if (entry) importCopyEntry(entry);
                e.currentTarget.value = "";
              }}
              defaultValue=""
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950"
            >
              <option value="">Import from copy library…</option>
              {copyEntries
                .filter((c) => c.variants.length > 0)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title} ({c.variants.length} variants)
                  </option>
                ))}
            </select>
          ) : null}
        </div>
        {variations.map((v, i) => (
          <div
            key={i}
            className="flex flex-col gap-2 rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950"
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-zinc-500">Variation {i + 1}</span>
              {variations.length > 1 ? (
                <button
                  type="button"
                  onClick={() => setVariations((prev) => prev.filter((_, j) => j !== i))}
                  className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-red-600 dark:hover:bg-zinc-800"
                  aria-label="Remove variation"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              ) : null}
            </div>
            <textarea
              value={v.primaryText}
              onChange={(e) => setVariation(i, { primaryText: e.target.value })}
              rows={3}
              placeholder="Primary text (required)"
              className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                value={v.headline}
                onChange={(e) => setVariation(i, { headline: e.target.value })}
                placeholder="Headline (optional)"
                className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
              />
              <input
                value={v.description}
                onChange={(e) => setVariation(i, { description: e.target.value })}
                placeholder="Description (optional)"
                className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
              />
            </div>
          </div>
        ))}
        {variations.length < 4 ? (
          <button
            type="button"
            onClick={() =>
              setVariations((prev) => [...prev, { primaryText: "", headline: "", description: "" }])
            }
            className="inline-flex w-fit items-center gap-1 text-[11px] text-blue-600 underline-offset-2 hover:underline"
          >
            <Plus className="h-3 w-3" /> Add variation
          </button>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">Link URL</span>
          <input
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="https://yourfunnel.com"
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">Call to action</span>
          <select value={cta} onChange={(e) => setCta(e.target.value)} className={inputCls}>
            <option value="">— None —</option>
            {CTA_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      </div>

      {files.length > 0 && filledVariations.length > 0 ? (
        <p className="text-[11px] text-zinc-500">
          {files.length} files → {files.length} new PAUSED ad sets (
          <code className="font-mono">
            {batchSlug}-1 … {batchSlug}-{files.length}
          </code>
          ), copy spread round-robin across {filledVariations.length} variation
          {filledVariations.length > 1 ? "s" : ""}. Note: if the template ad set carries its own
          daily budget (non-CBO), every copy inherits it.
        </p>
      ) : null}

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      ) : null}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={!canSubmit}
        className="inline-flex w-fit items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        <Rocket className="h-3.5 w-3.5" />
        {phase === "uploading"
          ? `Uploading ${uploadedCount}/${files.length}…`
          : phase === "queueing"
            ? "Queueing run…"
            : `Launch ${files.length || ""} paused drafts`}
      </button>
    </div>
  );
}
