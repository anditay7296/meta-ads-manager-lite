"use client";

import { useEffect, useState, useTransition } from "react";
import { ArrowRight, X, RefreshCw, AlertCircle, CheckCircle2, Wand2, Copy, Check } from "lucide-react";
import type { CampaignRow, CampaignsByAccount, AdSetRow } from "@/lib/db/queries/manager";
import {
  getAdSetsForCampaignAction,
  previewSyncAdSetsAction,
  syncAdSetsServerAction,
  previewCloneAdSetAction,
  previewSourceAdsAction,
  cloneAdSetServerAction,
  cloneAdSetIntoNewCampaignAction,
  fallbackPrepCloneAction,
  copyOneAdAction,
  fallbackCloneFinalizeAction,
  type SourceAdPreview,
} from "./actions";

const CLONE_SENTINEL = "__clone__";
// When the destination dropdown value starts with this prefix, the operator
// is cloning into an ad account that has zero campaigns yet — we'll create a
// PAUSED campaign in that account before cloning. The suffix is the
// destination ad-account UUID.
const NEW_IN_ACCOUNT_PREFIX = "__new_in_account__:";

type Props = {
  campaign: CampaignRow;
  groups: CampaignsByAccount[];
  onClose: () => void;
  /** Pre-select this source ad set when the dialog opens (e.g. when triggered from the Ad sets tab). */
  initialSrcAdSetMetaId?: string;
};

type Preview = {
  sourceCount: number;
  destCount: number;
  toCreate: number;
  toSkip: number;
};

type SyncResult = {
  created: number;
  skipped: number;
  failed: number;
  errors: string[];
  cloned?: boolean;
  customAudiencesFromRef?: boolean;
  customAudiencesStripped?: boolean;
  mirrored?: boolean;
  enhancementsPreserved?: number;
  enhancementsDropped?: number;
  needsManualIgFix?: number;
};

export function SyncAdSetsDialog({ campaign, groups, onClose, initialSrcAdSetMetaId }: Props) {
  // Source side
  const [srcAdSets, setSrcAdSets] = useState<AdSetRow[]>([]);
  const [srcAdSetMetaId, setSrcAdSetMetaId] = useState("");

  // Destination side — every other campaign in the project, grouped by ad account.
  // Includes same-account targets (GT1 → GT2 → GT3 within one account) and same-named
  // campaigns in other accounts. Accounts with zero campaigns are kept so the
  // operator can clone into a brand-new account (creates a fresh paused campaign).
  const destGroups = groups
    .map((g) => ({
      adAccountId: g.adAccountId,
      adAccountName: g.adAccountName,
      campaigns: g.campaigns.filter((c) => c.id !== campaign.id),
    }));
  const hasAnyDestOption = destGroups.some(
    (g) => g.campaigns.length > 0 || g.adAccountId !== campaign.adAccountId,
  );
  // Default selection: prefer same-name campaign in another account (preserves prior
  // behavior), otherwise first campaign in the same source account, otherwise first
  // campaign anywhere, otherwise the new-campaign sentinel for the first empty
  // non-source account.
  const defaultDestId = (() => {
    for (const g of destGroups) {
      const match = g.campaigns.find((c) => c.name === campaign.name);
      if (match) return match.id;
    }
    const sameAccount = destGroups.find((g) => g.adAccountName === campaign.adAccountName);
    if (sameAccount && sameAccount.campaigns[0]) return sameAccount.campaigns[0].id;
    for (const g of destGroups) {
      if (g.campaigns[0]) return g.campaigns[0].id;
    }
    const emptyAcct = destGroups.find(
      (g) => g.campaigns.length === 0 && g.adAccountId !== campaign.adAccountId,
    );
    return emptyAcct ? `${NEW_IN_ACCOUNT_PREFIX}${emptyAcct.adAccountId}` : "";
  })();
  const [destCampaignId, setDestCampaignId] = useState(defaultDestId);
  const [dstAdSets, setDstAdSets] = useState<AdSetRow[]>([]);
  const [dstAdSetMetaId, setDstAdSetMetaId] = useState("");

  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Per-source-ad audit (post ID, FB/IG placement, CTA URL) shown so the
  // operator can sanity-check what's about to be cloned. Loaded alongside
  // the count preview whenever the source ad set changes.
  const [srcAdsPreview, setSrcAdsPreview] = useState<SourceAdPreview[] | null>(
    null,
  );
  const [srcAdsPreviewLoading, setSrcAdsPreviewLoading] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [isPending, startTransition] = useTransition();
  // Track which ID chip was just copied so we can flash a Check icon on it
  // for 1.5s, mirroring the pattern in PixelPanel / TeamPanel.
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedValue(text);
      setTimeout(() => setCopiedValue((v) => (v === text ? null : v)), 1500);
    });
  };

  // Fallback clone state: when the regular clone errors out, the operator can
  // run "Try alternative method" which copies a destination ad set via Meta
  // /copies, renames it, then iterates source ads with progress updates.
  const [fallbackBusy, setFallbackBusy] = useState(false);
  const [fallbackProgress, setFallbackProgress] = useState<{
    pct: number;
    label: string;
    adsDone: number;
    adsTotal: number;
  } | null>(null);

  // Bulk-clone mode: iterate every source ad set in this campaign and clone
  // each into the destination, descending by ad code (AI016 → AD01). Server-
  // side cloneAdSetServerAction already auto-fallbacks on 2490487, so the
  // client loop stays simple — one call per ad set.
  const [mode, setMode] = useState<"single" | "bulk">("single");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{
    pct: number;
    label: string;
    setsDone: number;
    setsTotal: number;
  } | null>(null);
  const [bulkSummary, setBulkSummary] = useState<{
    setsSucceeded: number;
    setsFailed: number;
    adsCreated: number;
    adsSkipped: number;
    adsFailed: number;
    errors: { adSetName: string; message: string }[];
  } | null>(null);

  // Load source ad sets on mount
  useEffect(() => {
    getAdSetsForCampaignAction(campaign.id).then((r) => {
      if (r.ok && r.adSets) {
        setSrcAdSets(r.adSets);
        // Pre-select the ad set that triggered the dialog (from the Ad sets tab),
        // falling back to the first ad set in the list.
        const preselect = initialSrcAdSetMetaId
          ? (r.adSets.find((s) => s.metaAdSetId === initialSrcAdSetMetaId)?.metaAdSetId ?? r.adSets[0]?.metaAdSetId ?? "")
          : (r.adSets[0]?.metaAdSetId ?? "");
        setSrcAdSetMetaId(preselect);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign.id]);

  const isNewCampaignMode = destCampaignId.startsWith(NEW_IN_ACCOUNT_PREFIX);
  // Bulk mode can't target a brand-new campaign — we'd create one new
  // campaign per source ad set. Force-revert to single mode in that case.
  useEffect(() => {
    if (isNewCampaignMode && mode === "bulk") setMode("single");
  }, [isNewCampaignMode, mode]);

  // Sort source ad sets descending by ad code (AI016A → AD01) so the
  // operator's "largest first" preference is honoured in bulk mode.
  // Ad sets with no extractable code go to the bottom.
  const sortedSrcAdSets = (() => {
    const codeOf = (name: string) => {
      const m = name.match(/- ([A-Z]+\d+[A-Z]?) -/);
      return m ? m[1] : null;
    };
    const parts = (code: string | null) => {
      if (!code) return null;
      const m = code.match(/^([A-Z]+)(\d+)([A-Z]?)$/);
      if (!m) return null;
      return { letters: m[1], number: parseInt(m[2], 10), suffix: m[3] };
    };
    return [...srcAdSets].sort((a, b) => {
      const ap = parts(codeOf(a.name));
      const bp = parts(codeOf(b.name));
      if (ap && bp) {
        if (ap.letters !== bp.letters) return bp.letters.localeCompare(ap.letters);
        if (ap.number !== bp.number) return bp.number - ap.number;
        return (bp.suffix || "").localeCompare(ap.suffix || "");
      }
      if (ap && !bp) return -1;
      if (!ap && bp) return 1;
      return b.name.localeCompare(a.name);
    });
  })();
  // Load destination ad sets when dest campaign changes. Default to "clone whole
  // ad set" — operator opts into a specific destination ad set if they want to
  // merge into one. In new-campaign mode there's nothing to fetch (the campaign
  // doesn't exist yet) and the only legal mode is clone.
  useEffect(() => {
    if (!destCampaignId) return;
    setDstAdSets([]);
    setDstAdSetMetaId(CLONE_SENTINEL);
    if (destCampaignId.startsWith(NEW_IN_ACCOUNT_PREFIX)) return;
    getAdSetsForCampaignAction(destCampaignId).then((r) => {
      if (r.ok && r.adSets) {
        setDstAdSets(r.adSets);
      }
    });
  }, [destCampaignId]);

  const isCloneMode = dstAdSetMetaId === CLONE_SENTINEL;

  // Per-source-ad audit. Refetches whenever the source ad set changes
  // (independent of destination selection — operator sees what they're
  // about to clone as soon as they pick the source).
  useEffect(() => {
    if (!srcAdSetMetaId) {
      setSrcAdsPreview(null);
      return;
    }
    setSrcAdsPreview(null);
    setSrcAdsPreviewLoading(true);
    let cancelled = false;
    previewSourceAdsAction(srcAdSetMetaId)
      .then((r) => {
        if (cancelled) return;
        if (r.ok && r.ads) setSrcAdsPreview(r.ads);
      })
      .finally(() => {
        if (!cancelled) setSrcAdsPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [srcAdSetMetaId]);

  // Auto-preview whenever the source + a destination choice are set.
  useEffect(() => {
    if (!srcAdSetMetaId || !dstAdSetMetaId) {
      setPreview(null);
      return;
    }
    setPreview(null);
    setPreviewError(null);
    if (isCloneMode) {
      previewCloneAdSetAction(srcAdSetMetaId).then((r) => {
        if (r.ok) {
          setPreview({
            sourceCount: r.sourceCount,
            destCount: 0,
            toCreate: r.sourceCount,
            toSkip: 0,
          });
        } else {
          setPreviewError(r.message ?? "Preview failed");
        }
      });
      return;
    }
    previewSyncAdSetsAction(srcAdSetMetaId, dstAdSetMetaId).then((r) => {
      if (r.ok) {
        setPreview({
          sourceCount: r.sourceCount,
          destCount: r.destCount,
          toCreate: r.toCreate,
          toSkip: r.toSkip,
        });
      } else {
        setPreviewError(r.message ?? "Preview failed");
      }
    });
  }, [srcAdSetMetaId, dstAdSetMetaId, isCloneMode]);

  function handleSync() {
    if (!srcAdSetMetaId || !dstAdSetMetaId) return;
    startTransition(async () => {
      if (isCloneMode) {
        const r = isNewCampaignMode
          ? await cloneAdSetIntoNewCampaignAction(
              srcAdSetMetaId,
              destCampaignId.slice(NEW_IN_ACCOUNT_PREFIX.length),
            )
          : await cloneAdSetServerAction(srcAdSetMetaId, destCampaignId);
        if (r.ok && r.result) {
          setResult({
            ...r.result.ads,
            cloned: true,
            customAudiencesFromRef: r.result.customAudiencesFromRef,
            customAudiencesStripped: r.result.customAudiencesStripped,
            mirrored: r.result.mirrored,
          });
        } else {
          setPreviewError(r.message ?? "Clone failed");
        }
        return;
      }
      const r = await syncAdSetsServerAction(srcAdSetMetaId, dstAdSetMetaId, campaign.id);
      if (r.ok && r.result) {
        setResult(r.result);
      } else {
        setPreviewError(r.message ?? "Sync failed");
      }
    });
  }

  /**
   * Fallback clone path: triggered manually by the user when the regular clone
   * errors out. Copies a random ad set from the destination campaign via Meta's
   * native /copies endpoint, renames it to the source's name, then iterates
   * source ads one-at-a-time so progress can be displayed.
   */
  async function handleFallback() {
    if (!srcAdSetMetaId || !destCampaignId) return;
    setFallbackBusy(true);
    setPreviewError(null);
    setFallbackProgress({ pct: 5, label: "Duplicating an existing ad set in destination campaign…", adsDone: 0, adsTotal: 0 });

    const prep = await fallbackPrepCloneAction(srcAdSetMetaId, destCampaignId);
    if (!prep.ok || !prep.newAdSetMetaId) {
      setFallbackBusy(false);
      setFallbackProgress(null);
      setPreviewError(prep.message ?? "Fallback clone prep failed");
      return;
    }

    const ads = prep.srcAds ?? [];
    const total = ads.length;

    if (total === 0) {
      // New ad set was created but no source ads to copy.
      setFallbackProgress({ pct: 100, label: "Done — new ad set created (no source ads found).", adsDone: 0, adsTotal: 0 });
      await fallbackCloneFinalizeAction();
      setResult({
        created: 0, skipped: 0, failed: 0, errors: [],
        cloned: true, mirrored: true,
      });
      setFallbackBusy(false);
      return;
    }

    let created = 0;
    let skipped = 0;
    let failed = 0;
    let enhancementsPreserved = 0;
    let enhancementsDropped = 0;
    let needsManualIgFix = 0;
    const errors: string[] = [];

    for (let i = 0; i < total; i++) {
      const ad = ads[i];
      // Step contributes 5–95% range, leaving headroom for prep + finalize.
      const pct = Math.round(5 + ((i + 1) / total) * 90);
      setFallbackProgress({
        pct,
        label: `Copying ad ${i + 1} of ${total}: ${ad.name}`,
        adsDone: i,
        adsTotal: total,
      });
      const r = await copyOneAdAction(
        ad.metaId,
        ad.name,
        ad.creativeId,
        prep.newAdSetMetaId,
        prep.sameAccount,
      );
      if (r.ok) {
        if (r.skipped) skipped += 1;
        else {
          created += 1;
          if (r.enhancementsPreserved === true) enhancementsPreserved += 1;
          else if (r.enhancementsPreserved === false) enhancementsDropped += 1;
          if (r.needsManualIgFix) needsManualIgFix += 1;
        }
      } else {
        failed += 1;
        errors.push(`Ad "${ad.name}": ${r.message ?? "failed"}`);
      }
    }

    setFallbackProgress({ pct: 100, label: "Finalising…", adsDone: total, adsTotal: total });
    await fallbackCloneFinalizeAction();

    setResult({
      created, skipped, failed, errors,
      cloned: true,
      mirrored: true,
      enhancementsPreserved,
      enhancementsDropped,
      needsManualIgFix,
    });
    setFallbackBusy(false);
  }

  /**
   * Bulk clone path: iterate every source ad set in `sortedSrcAdSets` and
   * clone each into the destination campaign. cloneAdSetServerAction
   * already auto-falls back to the /copies workaround on the ROAS 2490487
   * subcode internally, so this loop stays a single call per ad set.
   * Aggregates per-set + per-ad counts and shows a summary panel on
   * completion with any per-set errors listed.
   */
  async function handleBulkClone() {
    if (sortedSrcAdSets.length === 0 || !destCampaignId) return;
    if (isNewCampaignMode) return;
    setBulkBusy(true);
    setPreviewError(null);
    setBulkSummary(null);
    const total = sortedSrcAdSets.length;
    let setsSucceeded = 0;
    let setsFailed = 0;
    let adsCreated = 0;
    let adsSkipped = 0;
    let adsFailed = 0;
    const errors: { adSetName: string; message: string }[] = [];

    for (let i = 0; i < total; i++) {
      const s = sortedSrcAdSets[i];
      const pct = Math.round(((i + 1) / total) * 100);
      setBulkProgress({
        pct,
        label: `Cloning ${i + 1} of ${total}: ${s.name}`,
        setsDone: i,
        setsTotal: total,
      });
      try {
        const r = await cloneAdSetServerAction(s.metaAdSetId, destCampaignId);
        if (r.ok && r.result) {
          setsSucceeded += 1;
          adsCreated += r.result.ads.created;
          adsSkipped += r.result.ads.skipped;
          adsFailed += r.result.ads.failed;
        } else {
          setsFailed += 1;
          errors.push({ adSetName: s.name, message: r.message ?? "Clone failed" });
        }
      } catch (err) {
        setsFailed += 1;
        errors.push({
          adSetName: s.name,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    setBulkProgress({
      pct: 100,
      label: "Done",
      setsDone: total,
      setsTotal: total,
    });
    setBulkSummary({
      setsSucceeded,
      setsFailed,
      adsCreated,
      adsSkipped,
      adsFailed,
      errors,
    });
    setBulkBusy(false);
  }

  const srcAccountName = campaign.adAccountName;
  // Resolve destination ad account name from the selected destination campaign so
  // operators can see at a glance whether they're cloning same-account or cross-account.
  const dstAccountName = (() => {
    if (isNewCampaignMode) {
      const acctId = destCampaignId.slice(NEW_IN_ACCOUNT_PREFIX.length);
      const g = destGroups.find((x) => x.adAccountId === acctId);
      return g?.adAccountName ?? "";
    }
    for (const g of destGroups) {
      if (g.campaigns.some((c) => c.id === destCampaignId)) return g.adAccountName;
    }
    return "";
  })();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="relative w-full max-w-4xl rounded-xl bg-white shadow-xl dark:bg-zinc-900">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4 dark:border-zinc-700">
          <div className="min-w-0 pr-3">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Sync ad sets
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              {campaign.name}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {result ? (
          /* Result view */
          <div className="px-5 py-6 space-y-4">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-6 w-6 shrink-0 text-green-600" />
              <div>
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {result.cloned ? "Clone complete" : "Sync complete"}
                </p>
                <p className="text-xs text-zinc-500">
                  {result.cloned ? "New ad set created · " : ""}
                  {result.created} copied · {result.skipped} skipped · {result.failed} failed
                </p>
              </div>
            </div>
            {result.mirrored ? (
              <p className="text-xs text-blue-600 dark:text-blue-400">
                All settings inherited from an existing ad set in the destination campaign — only the name and ads were taken from the source.
              </p>
            ) : (
              <>
                {result.customAudiencesFromRef && (
                  <p className="text-xs text-blue-600 dark:text-blue-400">
                    Custom audiences borrowed from an existing ad set in the destination campaign.
                  </p>
                )}
                {result.customAudiencesStripped && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    No reference ad set found — custom audiences were removed. Add them manually in the destination ad account.
                  </p>
                )}
              </>
            )}
            {(result.enhancementsPreserved ?? 0) > 0 && (result.enhancementsDropped ?? 0) === 0 && (
              <p className="text-xs text-blue-600 dark:text-blue-400">
                Creative enhancements preserved from source on {result.enhancementsPreserved} ad{result.enhancementsPreserved === 1 ? "" : "s"} — Multi-advertiser ads, Advantage+ destination, browser add-on (WhatsApp), and additional caption variations match the source ad.
              </p>
            )}
            {(result.enhancementsDropped ?? 0) > 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Creative enhancements could not be copied for {result.enhancementsDropped} ad{result.enhancementsDropped === 1 ? "" : "s"} — the Meta app lacks the capability for asset_feed_spec / degrees_of_freedom_spec. Set Multi-advertiser ads, browser add-on, and caption variations manually in Ads Manager for those ads.
              </p>
            )}
            {(result.needsManualIgFix ?? 0) > 0 && (
              <div className="rounded-lg border border-pink-300 bg-pink-50 p-3 dark:border-pink-900 dark:bg-pink-950">
                <p className="mb-1 text-xs font-medium text-pink-700 dark:text-pink-300">
                  🔧 {result.needsManualIgFix} IG-native ad{result.needsManualIgFix === 1 ? "" : "s"} need manual post fix
                </p>
                <p className="text-[11px] text-pink-700 dark:text-pink-300">
                  Source was Instagram-native but the cross-account rebuild
                  produced a &ldquo;Facebook post&rdquo;-tagged creative.
                  Open each ad in Ads Manager (look for the 🔧 prefix in
                  the ad name), click <strong>Change post</strong> →{" "}
                  <strong>Instagram</strong> tab → paste the{" "}
                  <strong>Post ID</strong> below into the{" "}
                  <em>Enter post ID</em> field (or use IG / Graph as
                  fallbacks), save, then remove the 🔧 prefix from the name.
                </p>
                {(() => {
                  const igAds = (srcAdsPreview ?? []).filter(
                    (a) => a.placement === "instagram",
                  );
                  if (igAds.length === 0) return null;
                  return (
                    <ul className="mt-2.5 space-y-1.5">
                      {igAds.map((ad) => (
                        <li
                          key={ad.metaAdId}
                          className="rounded border border-pink-200 bg-white px-2 py-1.5 dark:border-pink-900/60 dark:bg-zinc-900"
                        >
                          <p className="truncate text-[11px] font-medium text-zinc-900 dark:text-zinc-100">
                            {ad.name}
                          </p>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            {ad.instagramSourceMediaId && (
                              <button
                                type="button"
                                onClick={() => copyToClipboard(ad.instagramSourceMediaId!)}
                                className="inline-flex items-center gap-1 rounded border border-pink-300 bg-pink-100 px-1.5 py-0.5 font-mono text-[10px] font-medium text-pink-800 hover:bg-pink-200 dark:border-pink-800 dark:bg-pink-900/60 dark:text-pink-200 dark:hover:bg-pink-900"
                                title="Copy Post ID — paste into Ads Manager's 'Enter post ID' field"
                              >
                                Post ID: {ad.instagramSourceMediaId}
                                {copiedValue === ad.instagramSourceMediaId ? (
                                  <Check className="h-3 w-3 text-green-600" />
                                ) : (
                                  <Copy className="h-3 w-3 text-pink-500" />
                                )}
                              </button>
                            )}
                            {ad.instagramIgId && (
                              <button
                                type="button"
                                onClick={() => copyToClipboard(ad.instagramIgId!)}
                                className="inline-flex items-center gap-1 rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 font-mono text-[10px] text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                                title="Copy IG-side legacy ID (ig_id) — alternative ID for Ads Manager's Search by ID"
                              >
                                IG: {ad.instagramIgId}
                                {copiedValue === ad.instagramIgId ? (
                                  <Check className="h-3 w-3 text-green-600" />
                                ) : (
                                  <Copy className="h-3 w-3 text-zinc-400" />
                                )}
                              </button>
                            )}
                            {ad.postId && (
                              <button
                                type="button"
                                onClick={() => copyToClipboard(ad.postId!)}
                                className="inline-flex items-center gap-1 rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 font-mono text-[10px] text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                                title="Copy FB-side Graph media ID (effective_instagram_media_id)"
                              >
                                Graph: {ad.postId}
                                {copiedValue === ad.postId ? (
                                  <Check className="h-3 w-3 text-green-600" />
                                ) : (
                                  <Copy className="h-3 w-3 text-zinc-400" />
                                )}
                              </button>
                            )}
                            {ad.instagramPermalinkUrl && (
                              <a
                                href={ad.instagramPermalinkUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-[10px] text-pink-600 hover:underline dark:text-pink-400"
                              >
                                open IG ↗
                              </a>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  );
                })()}
              </div>
            )}
            {result.errors.length > 0 && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950">
                <p className="mb-1.5 text-xs font-medium text-red-700 dark:text-red-400">Errors</p>
                <ul className="space-y-1">
                  {result.errors.map((e, i) => (
                    <li key={i} className="text-xs text-red-600 dark:text-red-400">{e}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          /* Config view */
          <div className="px-5 py-5 space-y-5">
            {/* Mode toggle — choose between cloning a single picked ad set
                (default) or every ad set in the source campaign in one go. */}
            {srcAdSets.length > 1 && (
              <div className="inline-flex rounded-md border border-zinc-200 p-0.5 text-xs dark:border-zinc-700">
                <button
                  type="button"
                  onClick={() => setMode("single")}
                  disabled={bulkBusy}
                  className={
                    mode === "single"
                      ? "rounded bg-blue-600 px-3 py-1 font-medium text-white"
                      : "rounded px-3 py-1 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  }
                >
                  One ad set
                </button>
                <button
                  type="button"
                  onClick={() => setMode("bulk")}
                  disabled={bulkBusy || isNewCampaignMode}
                  title={
                    isNewCampaignMode
                      ? "Bulk mode requires an existing destination campaign"
                      : undefined
                  }
                  className={
                    mode === "bulk"
                      ? "rounded bg-blue-600 px-3 py-1 font-medium text-white"
                      : "rounded px-3 py-1 text-zinc-600 hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  }
                >
                  All {srcAdSets.length} ad sets
                </button>
              </div>
            )}

            {/* Source + Destination row */}
            <div className="flex items-start gap-3">
              {/* Source */}
              <div className="flex-1 space-y-2 min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Source</p>
                <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{srcAccountName}</p>
                {mode === "bulk" ? (
                  <div className="rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200">
                    All <strong>{srcAdSets.length}</strong> ad sets · cloning
                    descending by ad code
                    {sortedSrcAdSets[0] && (
                      <span className="block truncate text-[10px] text-blue-700/80 dark:text-blue-300/80">
                        starts with: {sortedSrcAdSets[0].name}
                      </span>
                    )}
                  </div>
                ) : (
                  <select
                    value={srcAdSetMetaId}
                    onChange={(e) => setSrcAdSetMetaId(e.target.value)}
                    className="w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 shadow-sm focus:border-blue-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                  >
                    {srcAdSets.length === 0 && (
                      <option value="">Loading…</option>
                    )}
                    {srcAdSets.map((s) => (
                      <option key={s.metaAdSetId} value={s.metaAdSetId}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="mt-8 shrink-0 text-zinc-400">
                <ArrowRight className="h-4 w-4" />
              </div>

              {/* Destination */}
              <div className="flex-1 space-y-2 min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Destination</p>
                {!hasAnyDestOption ? (
                  <p className="text-xs text-zinc-400">No other campaigns in this project.</p>
                ) : (
                  <>
                    <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                      {dstAccountName || "—"}
                    </p>
                    <select
                      value={destCampaignId}
                      onChange={(e) => setDestCampaignId(e.target.value)}
                      className="w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 shadow-sm focus:border-blue-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                    >
                      {destGroups.map((g) => {
                        const showNewOption =
                          g.campaigns.length === 0 && g.adAccountId !== campaign.adAccountId;
                        if (g.campaigns.length === 0 && !showNewOption) return null;
                        return (
                          <optgroup key={g.adAccountId} label={g.adAccountName}>
                            {g.campaigns.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                            {showNewOption && (
                              <option value={`${NEW_IN_ACCOUNT_PREFIX}${g.adAccountId}`}>
                                → New campaign in this account
                              </option>
                            )}
                          </optgroup>
                        );
                      })}
                    </select>
                    <select
                      value={dstAdSetMetaId}
                      onChange={(e) => setDstAdSetMetaId(e.target.value)}
                      disabled={isNewCampaignMode || mode === "bulk"}
                      className="w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 shadow-sm focus:border-blue-500 focus:outline-none disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                    >
                      <option value={CLONE_SENTINEL}>
                        ➕ Clone source ad set as new (with all ads)
                      </option>
                      {dstAdSets.map((s) => (
                        <option key={s.metaAdSetId} value={s.metaAdSetId}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </div>
            </div>

            {/* Preview */}
            {mode === "single" && preview && (
              <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-xs dark:border-zinc-700 dark:bg-zinc-800">
                <div className="flex items-center justify-between text-zinc-600 dark:text-zinc-400">
                  <span>Source: <strong className="text-zinc-900 dark:text-zinc-100">{preview.sourceCount} ads</strong></span>
                  <ArrowRight className="h-3 w-3" />
                  <span>
                    Destination:{" "}
                    <strong className="text-zinc-900 dark:text-zinc-100">
                      {isCloneMode ? "new ad set" : `${preview.destCount} ads`}
                    </strong>
                  </span>
                </div>
                <div className="mt-2 flex gap-3 text-zinc-500">
                  <span className="text-green-700 dark:text-green-400">
                    {isCloneMode
                      ? `Clone ad set + copy ${preview.toCreate} ad${preview.toCreate === 1 ? "" : "s"}`
                      : `+${preview.toCreate} to copy`}
                  </span>
                  {!isCloneMode && (
                    <>
                      <span>·</span>
                      <span>{preview.toSkip} duplicate{preview.toSkip === 1 ? "" : "s"} skipped</span>
                    </>
                  )}
                </div>
                {!isCloneMode && preview.toCreate === 0 && (
                  <p className="mt-1.5 text-amber-600 dark:text-amber-400">
                    Nothing to copy — destination already has all ads.
                  </p>
                )}
                {isCloneMode && preview.sourceCount === 0 && (
                  <p className="mt-1.5 text-amber-600 dark:text-amber-400">
                    Source ad set has no ads — the new ad set will be created empty.
                  </p>
                )}
              </div>
            )}

            {/* Per-source-ad verification panel — shows what will actually
                be cloned (post ID, FB/IG placement, CTA URL) so operators
                can spot wrong picks before committing. Hidden in bulk mode
                since iterating per-set audits across 237 ad sets would
                bury the Clone button. */}
            {mode === "single" && srcAdsPreviewLoading && (
              <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-xs text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800">
                <div className="flex items-center gap-2">
                  <RefreshCw className="h-3 w-3 shrink-0 animate-spin" />
                  Loading source post details…
                </div>
              </div>
            )}
            {mode === "single" && srcAdsPreview && srcAdsPreview.length > 0 && (
              <SrcAdsPreviewPanel ads={srcAdsPreview} />
            )}

            {/* Bulk progress bar — shown while iterating srcAdSets. Reuses
                the amber progress style from the single-set fallback flow. */}
            {bulkBusy && bulkProgress && (
              <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs dark:border-amber-900 dark:bg-amber-950/40">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300">
                    <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin" />
                    <span className="font-medium">Cloning all ad sets…</span>
                  </div>
                  <span className="text-[11px] tabular-nums text-amber-700 dark:text-amber-400">
                    {bulkProgress.pct}%
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-amber-200 dark:bg-amber-900">
                  <div
                    className="h-full bg-amber-600 transition-all duration-300"
                    style={{ width: `${bulkProgress.pct}%` }}
                  />
                </div>
                <p className="truncate text-[11px] text-amber-700 dark:text-amber-300">
                  {bulkProgress.label}
                </p>
                <p className="text-[11px] text-amber-600/80 dark:text-amber-400/80">
                  Ad sets: {bulkProgress.setsDone} / {bulkProgress.setsTotal}
                </p>
              </div>
            )}

            {/* Bulk summary — shown when the loop finishes, with per-set
                error list so the operator knows what to retry manually. */}
            {bulkSummary && !bulkBusy && (
              <div className="space-y-2 rounded-lg border border-green-200 bg-green-50 px-3 py-3 text-xs dark:border-green-900 dark:bg-green-950/40">
                <div className="flex items-center gap-2 text-green-800 dark:text-green-300">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span className="font-medium">
                    Bulk clone complete — {bulkSummary.setsSucceeded} ad set
                    {bulkSummary.setsSucceeded === 1 ? "" : "s"} cloned
                    {bulkSummary.setsFailed > 0
                      ? ` · ${bulkSummary.setsFailed} failed`
                      : ""}
                  </span>
                </div>
                <p className="text-[11px] text-green-700 dark:text-green-300">
                  Ads: {bulkSummary.adsCreated} copied · {bulkSummary.adsSkipped}{" "}
                  skipped · {bulkSummary.adsFailed} failed
                </p>
                {bulkSummary.errors.length > 0 && (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer text-[11px] font-medium text-red-700 dark:text-red-400">
                      {bulkSummary.errors.length} ad set
                      {bulkSummary.errors.length === 1 ? "" : "s"} failed —
                      click to expand
                    </summary>
                    <ul className="mt-1.5 max-h-40 space-y-1 overflow-y-auto pl-3 pr-1">
                      {bulkSummary.errors.map((e, i) => (
                        <li
                          key={i}
                          className="text-[11px] text-red-700 dark:text-red-400"
                        >
                          <strong>{e.adSetName}</strong>: {e.message}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}

            {mode === "single" && previewError && !fallbackBusy && (
              <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs dark:border-red-900 dark:bg-red-950">
                <div className="flex items-start gap-2 text-red-700 dark:text-red-400">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>{previewError}</span>
                </div>
                {isCloneMode && (
                  <div className="flex items-center justify-between gap-3 pt-1.5">
                    <p className="text-[11px] text-red-600/80 dark:text-red-400/80">
                      Try copying an existing ad set in the destination campaign
                      via Meta&apos;s native duplicate, then renaming it and copying
                      this source&apos;s ads in.
                    </p>
                    <button
                      type="button"
                      onClick={handleFallback}
                      disabled={fallbackBusy}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                    >
                      <Wand2 className="h-3.5 w-3.5" />
                      Try alternative method
                    </button>
                  </div>
                )}
              </div>
            )}

            {fallbackBusy && fallbackProgress && (
              <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs dark:border-amber-900 dark:bg-amber-950/40">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300">
                    <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin" />
                    <span className="font-medium">Cloning via alternative method…</span>
                  </div>
                  <span className="text-[11px] tabular-nums text-amber-700 dark:text-amber-400">
                    {fallbackProgress.pct}%
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-amber-200 dark:bg-amber-900">
                  <div
                    className="h-full bg-amber-600 transition-all duration-300"
                    style={{ width: `${fallbackProgress.pct}%` }}
                  />
                </div>
                <p className="truncate text-[11px] text-amber-700 dark:text-amber-300">
                  {fallbackProgress.label}
                </p>
                {fallbackProgress.adsTotal > 0 && (
                  <p className="text-[11px] text-amber-600/80 dark:text-amber-400/80">
                    Ads: {fallbackProgress.adsDone} / {fallbackProgress.adsTotal}
                  </p>
                )}
              </div>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between border-t border-zinc-100 pt-4 dark:border-zinc-800">
              <p className="text-[11px] text-zinc-400">
                {mode === "bulk"
                  ? `Clones every ad set in the source campaign into the destination, descending by ad code (e.g. AI016 → AD01). Server auto-falls back to /copies on ROAS errors. New ad sets + ads are PAUSED.`
                  : isCloneMode
                  ? "Clones the source ad set into the destination campaign with the same targeting + budget, then copies every ad. New ad set + ads are PAUSED."
                  : "Pick any GT2/GT3 in the same account, or the same-name campaign in another account. All copied ads are created as PAUSED."}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={fallbackBusy || bulkBusy}
                  className="rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  Cancel
                </button>
                {mode === "bulk" ? (
                  <button
                    type="button"
                    disabled={
                      bulkBusy ||
                      srcAdSets.length === 0 ||
                      !destCampaignId ||
                      isNewCampaignMode ||
                      !!bulkSummary
                    }
                    onClick={handleBulkClone}
                    className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {bulkBusy ? (
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    {bulkBusy
                      ? `Cloning ${bulkProgress?.setsDone ?? 0}/${srcAdSets.length}…`
                      : bulkSummary
                      ? "Done"
                      : `Clone all ${srcAdSets.length} ad sets`}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={
                      isPending ||
                      fallbackBusy ||
                      !srcAdSetMetaId ||
                      !dstAdSetMetaId ||
                      !hasAnyDestOption ||
                      (!isCloneMode && preview?.toCreate === 0)
                    }
                    onClick={handleSync}
                    className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {isPending ? (
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    {isPending
                      ? isCloneMode
                        ? "Cloning…"
                        : "Syncing…"
                      : isCloneMode
                      ? "Clone ad set"
                      : "Sync ads"}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Verification panel — renders a per-ad post-attribution summary so the
 * operator can spot IG-vs-FB mismatches before clicking Clone. Collapsed
 * by default with a one-line summary; expanding caps the height with an
 * internal scroll so big source ad sets (50+ ads in GT3) don't overflow
 * the dialog and hide the Clone button.
 */
function SrcAdsPreviewPanel({ ads }: { ads: SourceAdPreview[] }) {
  const [expanded, setExpanded] = useState(false);
  const instagramCount = ads.filter((a) => a.placement === "instagram").length;
  const facebookCount = ads.filter((a) => a.placement === "facebook").length;
  const unknownCount = ads.length - instagramCount - facebookCount;

  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 text-xs dark:border-zinc-700 dark:bg-zinc-900">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          Verify source posts before clone
        </span>
        <span className="flex items-center gap-2 text-[10px] text-zinc-500">
          <span>
            {ads.length} ad{ads.length === 1 ? "" : "s"}
            {instagramCount > 0 ? ` · ${instagramCount} IG` : ""}
            {facebookCount > 0 ? ` · ${facebookCount} FB` : ""}
            {unknownCount > 0 ? ` · ${unknownCount} ?` : ""}
          </span>
          <span aria-hidden="true">{expanded ? "▼" : "▶"}</span>
        </span>
      </button>
      {expanded && (
        <>
          <ul className="mt-3 max-h-80 space-y-2.5 overflow-y-auto pr-1">
            {ads.map((ad) => (
              <li
                key={ad.metaAdId}
                className="rounded-md border border-zinc-100 px-3 py-2 dark:border-zinc-800"
              >
                <p className="truncate text-[11px] font-medium text-zinc-900 dark:text-zinc-100">
                  {ad.name}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <span
                    className={
                      ad.placement === "instagram"
                        ? "rounded bg-pink-100 px-1.5 py-0.5 text-[10px] font-medium text-pink-800 dark:bg-pink-950 dark:text-pink-300"
                        : ad.placement === "facebook"
                          ? "rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-300"
                          : "rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300"
                    }
                  >
                    {ad.placement === "instagram"
                      ? "Instagram post"
                      : ad.placement === "facebook"
                        ? "Facebook post"
                        : "Unknown post"}
                  </span>
                  {ad.instagramSourceMediaId && (
                    <span className="font-mono text-[10px] text-pink-700 dark:text-pink-300">
                      Post ID: {ad.instagramSourceMediaId}
                    </span>
                  )}
                  {ad.postId && (
                    <span className="font-mono text-[10px] text-zinc-500">
                      {ad.placement === "instagram" ? "Graph: " : ""}
                      {ad.postId}
                    </span>
                  )}
                  {ad.instagramIgId && (
                    <span className="font-mono text-[10px] text-zinc-500">
                      IG: {ad.instagramIgId}
                    </span>
                  )}
                </div>
                {ad.instagramPermalinkUrl && (
                  <p className="mt-1 truncate text-[10px] text-zinc-500">
                    IG →{" "}
                    <a
                      href={ad.instagramPermalinkUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-pink-600 hover:underline dark:text-pink-400"
                    >
                      {ad.instagramPermalinkUrl}
                    </a>
                  </p>
                )}
                {ad.ctaUrl && (
                  <p className="mt-1 truncate text-[10px] text-zinc-500">
                    CTA →{" "}
                    <a
                      href={ad.ctaUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {ad.ctaUrl}
                    </a>
                  </p>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[10px] text-zinc-400">
            If any post tag or CTA looks wrong, fix it at the source in Ads
            Manager first, then re-open this dialog.
          </p>
        </>
      )}
    </div>
  );
}
