import { inngest } from "./client";
import { db, schema } from "@/lib/db/client";
import { and, eq, sql } from "drizzle-orm";
import { getMetaClientForMetaAccountId } from "@/lib/meta/get-client";
import {
  createFactoryAdSet,
  createVariationAd,
  type VariationSpec,
} from "@/lib/meta/actions";
import { journalAppend } from "@/lib/db/queries/journal";

const { factoryRuns, adAccounts, adSets, campaigns, pages, orgSettings } = schema;

/**
 * Durable bulk-launch: N uploaded creatives → N new PAUSED ad sets (each a
 * shallow Meta /copies of a template ad set) with exactly ONE paused draft ad
 * inside. Backs the factory page's Bulk mode (app/(app)/campaigns/factory).
 *
 * Design notes:
 *  - Work is chunked (10 video uploads / 8 ad creations per step.run) rather
 *    than one step per item — a 50-item run costs ~15 step executions, which
 *    matters against the Inngest free-tier execution quota.
 *  - Every chunk re-reads the run row and every create chunk re-lists the
 *    destination campaign's ad sets by NAME before creating, so retries and
 *    replays are duplicate-safe even though Meta /copies is not idempotent.
 *  - Videos upload by `file_url` (Meta pulls from the Supabase public URL) and
 *    process asynchronously; a bounded escalating poll loop waits for `ready`
 *    and harvests Meta's auto-thumbnail (video_data creatives require one).
 *  - Progress is written to the factory_runs row after each chunk so the
 *    /campaigns/factory/runs/[runId] page can poll it (no websockets).
 */

export type FactoryRunEventData = {
  orgId: string;
  runId: string;
  adAccountMetaId: string; // act_xxx — concurrency key
  triggeredBy: string; // userId
};

export type FactoryCopyVariation = {
  primaryText: string;
  headline?: string;
  description?: string;
};

export type FactoryRunItem = {
  index: number;
  kind: "image" | "video";
  fileName: string;
  assetUrl: string;
  /** Which copySet entry this creative uses (round-robin, index % copySet.length). */
  copyIndex: number;
  adSetName: string;
  adName: string;
  status:
    | "pending"
    | "video_uploaded"
    | "video_ready"
    | "adset_created"
    | "created"
    | "skipped"
    | "failed";
  metaVideoId?: string;
  thumbnailUrl?: string;
  metaAdSetId?: string;
  localAdSetId?: string;
  metaCreativeId?: string;
  metaAdId?: string;
  draftAdId?: string;
  error?: string;
};

const VIDEO_UPLOAD_CHUNK = 10;
const CREATE_CHUNK = 8; // ~6 Meta calls per item — 8 items stays well under maxDuration=300s
const ITEM_PACE_MS = 300;
const ITEM_ATTEMPTS = 2; // bounded in-chunk self-heal for transient Meta/DB blips
// Escalating waits between video-status polls (~8 min total before timeout).
const POLL_WAITS = ["45s", "60s", "90s", "120s", "180s"] as const;

function countByStatus(items: FactoryRunItem[]) {
  let created = 0;
  let skipped = 0;
  let failed = 0;
  for (const it of items) {
    if (it.status === "created") created += 1;
    else if (it.status === "skipped") skipped += 1;
    else if (it.status === "failed") failed += 1;
  }
  return { created, skipped, failed };
}

async function readItems(runId: string): Promise<FactoryRunItem[]> {
  const [row] = await db
    .select({ items: factoryRuns.items })
    .from(factoryRuns)
    .where(eq(factoryRuns.id, runId))
    .limit(1);
  return (row?.items as FactoryRunItem[] | null) ?? [];
}

async function writeItems(runId: string, items: FactoryRunItem[]): Promise<void> {
  const counts = countByStatus(items);
  await db
    .update(factoryRuns)
    .set({
      items: items as unknown,
      created: counts.created,
      skipped: counts.skipped,
      failed: counts.failed,
      updatedAt: sql`now()`,
    })
    .where(eq(factoryRuns.id, runId));
}

export const factoryRun = inngest.createFunction(
  {
    id: "factory-run",
    name: "Variation factory bulk run",
    triggers: [{ event: "factory/run.requested" }],
    // Meta throttles per ad account; serializing also keeps a replayed event
    // from racing duplicates past the skip-by-name re-check.
    concurrency: { key: "event.data.adAccountMetaId", limit: 1 },
    retries: 3,
  },
  async ({ event, step }) => {
    const data = event.data as FactoryRunEventData;
    const { orgId, runId, adAccountMetaId, triggeredBy } = data;
    const actor = { type: "user" as const, userId: triggeredBy };

    // A) Load the run + resolve every Meta-side id once. Terminal runs exit
    //    immediately (dedupe of replayed events).
    const ctx = await step.run("load-run", async () => {
      const [run] = await db
        .select()
        .from(factoryRuns)
        .where(and(eq(factoryRuns.id, runId), eq(factoryRuns.orgId, orgId)))
        .limit(1);
      if (!run) throw new Error(`factory run ${runId} not found`);
      if (run.status === "done" || run.status === "done_with_errors" || run.status === "failed") {
        return null;
      }

      const [acct] = await db
        .select({ id: adAccounts.id, metaAccountId: adAccounts.metaAccountId, name: adAccounts.name })
        .from(adAccounts)
        .where(and(eq(adAccounts.orgId, orgId), eq(adAccounts.id, run.adAccountId)))
        .limit(1);
      const [camp] = await db
        .select({ id: campaigns.id, metaCampaignId: campaigns.metaCampaignId, name: campaigns.name })
        .from(campaigns)
        .where(and(eq(campaigns.orgId, orgId), eq(campaigns.id, run.campaignId)))
        .limit(1);
      const [template] = await db
        .select({ metaAdSetId: adSets.metaAdSetId, name: adSets.name })
        .from(adSets)
        .where(and(eq(adSets.orgId, orgId), eq(adSets.id, run.templateAdSetId)))
        .limit(1);
      const [pageRow] = await db
        .select({ metaPageId: pages.metaPageId, name: pages.name })
        .from(pages)
        .where(and(eq(pages.orgId, orgId), eq(pages.id, run.pageId)))
        .limit(1);
      if (!acct || !camp || !template || !pageRow) {
        await db
          .update(factoryRuns)
          .set({
            status: "failed",
            error: "Ad account, campaign, template ad set, or page no longer exists",
            updatedAt: sql`now()`,
          })
          .where(eq(factoryRuns.id, runId));
        return null;
      }

      const [settings] = await db
        .select({
          defaultPixelId: orgSettings.defaultPixelId,
          pixelAutoAttach: orgSettings.pixelAutoAttach,
        })
        .from(orgSettings)
        .where(eq(orgSettings.orgId, orgId))
        .limit(1);

      const items = (run.items as FactoryRunItem[] | null) ?? [];
      await db
        .update(factoryRuns)
        .set({ status: "running", total: items.length, updatedAt: sql`now()` })
        .where(eq(factoryRuns.id, runId));

      return {
        acct,
        camp,
        templateMetaAdSetId: template.metaAdSetId,
        page: pageRow,
        pixelToAttach:
          settings?.pixelAutoAttach && settings.defaultPixelId
            ? settings.defaultPixelId
            : null,
        copySet: (run.copySet as FactoryCopyVariation[] | null) ?? [],
        linkUrl: run.linkUrl,
        callToAction: run.callToAction,
        batchSlug: run.batchSlug,
        totalItems: items.length,
        videoCount: items.filter((i) => i.kind === "video").length,
      };
    });
    if (!ctx) return { runId, exited: "terminal-or-missing" };

    // B) Upload videos to the ad account (instant call — Meta fetches the
    //    bytes from Supabase itself and processes asynchronously).
    if (ctx.videoCount > 0) {
      const chunkCount = Math.ceil(ctx.totalItems / VIDEO_UPLOAD_CHUNK);
      for (let c = 0; c < chunkCount; c++) {
        await step.run(`upload-videos-${c}`, async () => {
          const items = await readItems(runId);
          const meta = await getMetaClientForMetaAccountId(orgId, adAccountMetaId);
          if (!meta) throw new Error("No Meta connection for ad account");
          let touched = false;
          for (const it of items.slice(c * VIDEO_UPLOAD_CHUNK, (c + 1) * VIDEO_UPLOAD_CHUNK)) {
            if (it.kind !== "video" || it.metaVideoId || it.status === "failed") continue;
            try {
              const up = await meta.client.uploadAdVideo({
                adAccountId: adAccountMetaId,
                fileUrl: it.assetUrl,
                name: it.adName,
                calledBy: "factory-run",
              });
              it.metaVideoId = up.id;
              it.status = "video_uploaded";
            } catch (err) {
              it.status = "failed";
              it.error = `video upload: ${err instanceof Error ? err.message : String(err)}`;
            }
            touched = true;
            await new Promise((r) => setTimeout(r, ITEM_PACE_MS));
          }
          if (touched) await writeItems(runId, items);
        });
      }

      // C) Bounded escalating poll until every uploaded video is ready (or
      //    errored). Each round also harvests Meta's auto-thumbnail — Meta
      //    rejects thumbnail-less video_data creatives.
      let remaining = ctx.videoCount;
      for (let r = 0; r < POLL_WAITS.length && remaining > 0; r++) {
        await step.sleep(`video-wait-${r}`, POLL_WAITS[r]);
        remaining = await step.run(`check-videos-${r}`, async () => {
          const items = await readItems(runId);
          const meta = await getMetaClientForMetaAccountId(orgId, adAccountMetaId);
          if (!meta) throw new Error("No Meta connection for ad account");
          let stillProcessing = 0;
          let touched = false;
          for (const it of items) {
            if (it.kind !== "video" || !it.metaVideoId) continue;
            if (it.status !== "video_uploaded") continue;
            try {
              const st = await meta.client.getVideoStatus(it.metaVideoId, "factory-run");
              const vs = st.status?.video_status;
              if (vs === "ready") {
                const thumbs = await meta.client.listVideoThumbnails(it.metaVideoId, "factory-run");
                const preferred =
                  thumbs.data?.find((t) => t.is_preferred) ?? thumbs.data?.[0];
                if (preferred?.uri) {
                  it.thumbnailUrl = preferred.uri;
                  it.status = "video_ready";
                } else {
                  // Thumbnails can lag readiness by a beat — leave the item in
                  // video_uploaded so the next round re-fetches; the timeout
                  // step below fails it if they never appear.
                  stillProcessing += 1;
                }
              } else if (vs === "error") {
                it.status = "failed";
                it.error = "Meta could not process this video";
              } else {
                stillProcessing += 1;
              }
              touched = true;
            } catch {
              // Transient status-check failure — count as still processing and
              // let the next round (or Inngest's step retry) recheck.
              stillProcessing += 1;
            }
          }
          if (touched) await writeItems(runId, items);
          return stillProcessing;
        });
      }
      if (remaining > 0) {
        await step.run("video-timeout", async () => {
          const items = await readItems(runId);
          let touched = false;
          for (const it of items) {
            if (it.kind === "video" && it.status === "video_uploaded") {
              it.status = "failed";
              it.error = "video processing timed out (or no thumbnail available)";
              touched = true;
            }
          }
          if (touched) await writeItems(runId, items);
        });
      }
    }

    // D) Create one ad set + one ad per creative, in chunks. Skip-by-name
    //    against a fresh dest-campaign listing at every chunk start makes
    //    retries duplicate-safe.
    const createChunks = Math.ceil(ctx.totalItems / CREATE_CHUNK);
    for (let c = 0; c < createChunks; c++) {
      await step.run(`create-${c}`, async () => {
        const items = await readItems(runId);
        const meta = await getMetaClientForMetaAccountId(orgId, adAccountMetaId);
        if (!meta) throw new Error("No Meta connection for ad account");

        const destList = await meta.client.listAdSetsForCampaign(ctx.camp.metaCampaignId);
        const existingByName = new Map(destList.data.map((d) => [d.name, d.id]));

        let touched = false;
        for (const it of items.slice(c * CREATE_CHUNK, (c + 1) * CREATE_CHUNK)) {
          if (it.status === "created" || it.status === "skipped" || it.status === "failed") continue;
          if (it.metaAdId) {
            it.status = "created";
            touched = true;
            continue;
          }
          if (it.kind === "video" && it.status !== "video_ready") {
            it.status = "failed";
            it.error = it.error ?? "video never became ready";
            touched = true;
            continue;
          }

          let lastErr = "";
          for (let attempt = 1; attempt <= ITEM_ATTEMPTS; attempt++) {
            try {
              // 1) Ensure the ad set (reuse a same-named one left by a crashed
              //    earlier attempt rather than duplicating it).
              if (!it.metaAdSetId) {
                const existingId = existingByName.get(it.adSetName);
                if (existingId) {
                  it.metaAdSetId = existingId;
                  const [local] = await db
                    .select({ id: adSets.id })
                    .from(adSets)
                    .where(and(eq(adSets.orgId, orgId), eq(adSets.metaAdSetId, existingId)))
                    .limit(1);
                  it.localAdSetId = local?.id;
                } else {
                  const created = await createFactoryAdSet({
                    orgId,
                    actor,
                    client: meta.client,
                    templateMetaAdSetId: ctx.templateMetaAdSetId,
                    destAccountMetaId: adAccountMetaId,
                    destCampaign: ctx.camp,
                    name: it.adSetName,
                  });
                  it.metaAdSetId = created.metaAdSetId;
                  it.localAdSetId = created.localId;
                  existingByName.set(it.adSetName, created.metaAdSetId);
                }
                it.status = "adset_created";
              }
              if (!it.localAdSetId) {
                // Reused an ad set Meta knows but the local cache doesn't
                // (e.g. created in Ads Manager) — cache it now so the ads row
                // below has a parent.
                const [ins] = await db
                  .insert(adSets)
                  .values({
                    orgId,
                    campaignId: ctx.camp.id,
                    metaAdSetId: it.metaAdSetId!,
                    name: it.adSetName,
                    status: "PAUSED",
                    effectiveStatus: "PAUSED",
                  })
                  .onConflictDoUpdate({
                    target: [adSets.orgId, adSets.metaAdSetId],
                    set: { updatedAt: sql`now()` },
                  })
                  .returning({ id: adSets.id });
                it.localAdSetId = ins.id;
              }

              // 2) Create the single ad inside it.
              const copy = ctx.copySet[it.copyIndex] ?? ctx.copySet[0];
              if (!copy) throw new Error("run has an empty copy set");
              const spec: VariationSpec = {
                pain_point_slug: ctx.batchSlug,
                variation_number: it.index + 1,
                primary_text: copy.primaryText,
                ...(copy.headline ? { headline: copy.headline } : {}),
                ...(copy.description ? { description: copy.description } : {}),
                ...(ctx.linkUrl ? { link_url: ctx.linkUrl } : {}),
                ...(ctx.callToAction
                  ? { call_to_action: ctx.callToAction as VariationSpec["call_to_action"] }
                  : {}),
                ...(it.kind === "video"
                  ? { video_id: it.metaVideoId, thumbnail_url: it.thumbnailUrl }
                  : { image_url: it.assetUrl }),
              };
              const r = await createVariationAd({
                orgId,
                actor,
                client: meta.client,
                acct: { metaAccountId: ctx.acct.metaAccountId, name: ctx.acct.name },
                adSet: { id: it.localAdSetId!, metaAdSetId: it.metaAdSetId!, name: it.adSetName },
                page: { metaPageId: ctx.page.metaPageId, name: ctx.page.name },
                pixelToAttach: ctx.pixelToAttach,
                spec,
              });
              if (!r.ok) throw new Error(r.error ?? "ad creation failed");
              it.metaAdId = r.metaAdId;
              it.metaCreativeId = r.metaCreativeId;
              it.draftAdId = r.draftAdId;
              it.status = "created";
              it.error = undefined;
              break;
            } catch (err) {
              lastErr = err instanceof Error ? err.message : String(err);
              if (attempt < ITEM_ATTEMPTS) await new Promise((r) => setTimeout(r, 3000));
            }
          }
          if (it.status !== "created") {
            it.status = "failed";
            it.error = lastErr || it.error || "unknown error";
          }
          touched = true;
          await new Promise((r) => setTimeout(r, ITEM_PACE_MS));
        }
        if (touched) await writeItems(runId, items);
      });
    }

    // E) Finalize + one summary journal entry (per-ad-set / per-ad entries
    //    were already written by the shared helpers).
    return step.run("finalize", async () => {
      const items = await readItems(runId);
      const counts = countByStatus(items);
      const status: "done" | "done_with_errors" =
        counts.failed > 0 ? "done_with_errors" : "done";
      await db
        .update(factoryRuns)
        .set({ status, updatedAt: sql`now()` })
        .where(eq(factoryRuns.id, runId));
      await journalAppend({
        orgId,
        actorType: "user",
        actorRef: triggeredBy,
        summary: `Factory bulk run "${ctx.batchSlug}": ${counts.created} ad sets+ads created, ${counts.skipped} skipped, ${counts.failed} failed (all PAUSED)`,
        entityKind: "campaign",
        entityId: ctx.camp.id,
        after: { ...counts, status },
        metadata: { action: "factory_bulk_run", runId, batchSlug: ctx.batchSlug },
      });
      return { runId, ...counts, status };
    });
  },
);
