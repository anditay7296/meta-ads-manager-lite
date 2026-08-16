import { db, schema } from "@/lib/db/client";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { MetaClient } from "@/lib/meta/client";
import type { MetaAd } from "@/lib/meta/types";
import {
  cacheCreativeThumb,
  ensureCreativeThumbsBucket,
} from "@/lib/storage";

const { adCreatives, ads } = schema;

export type CreativeSyncResult = {
  /** Number of creatives upserted into the local cache. */
  upserted: number;
  /** Map of meta_creative_id → local ad_creatives.id, so the caller can
   *  populate `ads.creativeId` during the ads upsert in the same pass. */
  idMap: Map<string, string>;
};

// Mirror the same chunk size as the rest of sync.ts — Postgres' 65 534 param
// cap means a 12-column upsert tops out around 5 400 rows per query.
const UPSERT_CHUNK_ROWS = 500;

// Rehost at most this many not-yet-cached stills per account per sync, so the
// first post-deploy run (where everything is uncached) stays bounded; the
// remainder are picked up on later runs. Steady state is ~0 — only brand-new
// creatives need caching. Use the backfill script to cache everything at once.
const MAX_CACHE_PER_RUN = 80;
// Parallel download+upload jobs — modest, to avoid hammering Meta's CDN.
const CACHE_CONCURRENCY = 5;

function* chunked<T>(arr: T[], size: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}

/**
 * Pull display data for every creative referenced by the supplied ads and
 * upsert into `ad_creatives`.
 *
 * **Why ad-derived, not account-wide:** `/{ad_account}/adcreatives` returns
 * every creative ever uploaded to the account. Mature accounts have
 * thousands; the response trips Meta's "Please reduce the amount of data"
 * guard. We instead batch-fetch by creative ID (extracted from the ads we
 * just listed) — costs exactly what we display.
 *
 * Returns a Map<meta_creative_id, ad_creatives.id> so the caller can
 * populate `ads.creativeId` during the ads upsert in the same sync pass.
 *
 * Idempotent: re-running upserts the same rows. Meta-CDN URLs in
 * `thumbnail_url` / `image_url` expire after ~30d, so this should run on
 * the daily sync cadence to keep thumbnails fresh in the card grid.
 */
export async function syncCreativesForAccount(opts: {
  client: MetaClient;
  orgId: string;
  adAccount: { id: string; metaAccountId: string };
  /** Ads returned by `MetaClient.listAds` for this account in the same
   *  sync pass. We extract `creative.id` from each to know which creatives
   *  to fetch. */
  ads: MetaAd[];
}): Promise<CreativeSyncResult> {
  const { client, orgId, adAccount, ads } = opts;

  const creativeIds = ads
    .map((a) => a.creative?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  if (creativeIds.length === 0) {
    // No ads have creatives. Surface any pre-existing rows so ads.creativeId
    // can still be linked on subsequent passes.
    const existing = await db
      .select({ id: adCreatives.id, metaId: adCreatives.metaCreativeId })
      .from(adCreatives)
      .where(
        and(
          eq(adCreatives.orgId, orgId),
          eq(adCreatives.adAccountId, adAccount.id),
        ),
      );
    return {
      upserted: 0,
      idMap: new Map(existing.map((c) => [c.metaId, c.id])),
    };
  }

  const fetched = await client.getCreativesBatch(creativeIds, {
    calledBy: "syncCreativesForAccount",
  });

  if (fetched.size === 0) {
    // Meta returned no creatives (permissions / deleted) — same fallback
    // as the empty-ids case.
    const existing = await db
      .select({ id: adCreatives.id, metaId: adCreatives.metaCreativeId })
      .from(adCreatives)
      .where(
        and(
          eq(adCreatives.orgId, orgId),
          eq(adCreatives.adAccountId, adAccount.id),
        ),
      );
    return {
      upserted: 0,
      idMap: new Map(existing.map((c) => [c.metaId, c.id])),
    };
  }

  const rows = Array.from(fetched.values()).map((c) => ({
    orgId,
    adAccountId: adAccount.id,
    metaCreativeId: c.id,
    name: c.name ?? null,
    title: c.title ?? null,
    body: c.body ?? null,
    imageUrl: c.image_url ?? null,
    thumbnailUrl: c.thumbnail_url ?? null,
    videoId: c.video_id ?? null,
    mediaKind: deriveMediaKind(c),
    objectStorySpec: c.object_story_spec ?? null,
    // raw intentionally NOT stored: the full creative dump (~10 KB/row) was
    // the #1 Supabase disk-IO consumer (rewritten every sync, nulled every
    // night by audit-prune-daily — pure TOAST churn). Nothing reads it;
    // object_story_spec above carries everything the clone flows need.
    raw: null,
    lastSyncedAt: new Date(),
  }));

  for (const chunk of chunked(rows, UPSERT_CHUNK_ROWS)) {
    await db
      .insert(adCreatives)
      .values(chunk)
      .onConflictDoUpdate({
        target: [adCreatives.orgId, adCreatives.metaCreativeId],
        set: {
          name: sql`excluded.name`,
          title: sql`excluded.title`,
          body: sql`excluded.body`,
          imageUrl: sql`excluded.image_url`,
          thumbnailUrl: sql`excluded.thumbnail_url`,
          videoId: sql`excluded.video_id`,
          mediaKind: sql`excluded.media_kind`,
          objectStorySpec: sql`excluded.object_story_spec`,
          // raw deliberately absent from the update set — see insert comment.
          lastSyncedAt: sql`now()`,
        },
        // Skip unchanged creatives — creatives are immutable on Meta's side
        // in practice, so this makes the steady-state sync a pure no-op
        // instead of rewriting ~14k rows (heap+index+WAL) every tick.
        //
        // image_url / thumbnail_url are special: Meta's CDN rotates the
        // signature params (_nc_*, ccb) on every fetch, so they compare as
        // "different" on every single sync. They do expire eventually, so
        // refresh them — but at most once per 20h per row, not 48×/day.
        setWhere: sql`(${adCreatives.name}, ${adCreatives.title}, ${adCreatives.body}, ${adCreatives.videoId}, ${adCreatives.mediaKind}, ${adCreatives.objectStorySpec}) IS DISTINCT FROM (excluded.name, excluded.title, excluded.body, excluded.video_id, excluded.media_kind, excluded.object_story_spec) OR ((${adCreatives.imageUrl}, ${adCreatives.thumbnailUrl}) IS DISTINCT FROM (excluded.image_url, excluded.thumbnail_url) AND ${adCreatives.lastSyncedAt} < now() - interval '20 hours')`,
      });
  }

  // Read back the local UUIDs so caller can wire ads.creativeId. Also pull
  // cached_thumb_url so we know which stills still need rehosting.
  const metaIds = rows.map((r) => r.metaCreativeId);
  const localRows = await db
    .select({
      id: adCreatives.id,
      metaId: adCreatives.metaCreativeId,
      cachedThumbUrl: adCreatives.cachedThumbUrl,
    })
    .from(adCreatives)
    .where(
      and(
        eq(adCreatives.orgId, orgId),
        inArray(adCreatives.metaCreativeId, metaIds),
      ),
    );

  // Best-effort: rehost newly-seen stills into our own storage so the card
  // survives Meta's ~30d signed-URL expiry. Source is the full-res image_url
  // when present, else the 600px thumbnail_url. Never throws into sync.
  const srcByMetaId = new Map(
    Array.from(fetched.values()).map((c) => [
      c.id,
      c.image_url ?? c.thumbnail_url ?? null,
    ]),
  );
  await rehostUncachedThumbnails({ orgId, localRows, srcByMetaId });

  return {
    upserted: rows.length,
    idMap: new Map(localRows.map((c) => [c.metaId, c.id])),
  };
}

/**
 * Download the best still for each not-yet-cached creative and rehost it to
 * the public `creative-thumbs` bucket, writing the stable public URL back to
 * `ad_creatives.cached_thumb_url`. Bounded (`MAX_CACHE_PER_RUN`) and
 * concurrency-limited; every failure is swallowed so caching can never break
 * the surrounding sync.
 */
async function rehostUncachedThumbnails(opts: {
  orgId: string;
  localRows: { id: string; metaId: string; cachedThumbUrl: string | null }[];
  srcByMetaId: Map<string, string | null>;
}): Promise<void> {
  const uncached = opts.localRows
    .filter((r) => !r.cachedThumbUrl)
    .map((r) => ({ id: r.id, metaId: r.metaId, src: opts.srcByMetaId.get(r.metaId) }))
    .filter((x): x is { id: string; metaId: string; src: string } => !!x.src);

  if (uncached.length === 0) return;

  // Skip rehosting for creatives whose every ad is ARCHIVED or DELETED —
  // those thumbs were pruned intentionally and should not be re-cached.
  const uncachedIds = uncached.map((x) => x.id);
  const activeCreativeRows = await db
    .selectDistinct({ creativeId: ads.creativeId })
    .from(ads)
    .where(
      and(
        inArray(ads.creativeId, uncachedIds),
        notInArray(ads.effectiveStatus, ["ARCHIVED", "DELETED"]),
      ),
    );
  const activeSet = new Set(
    activeCreativeRows
      .map((r) => r.creativeId)
      .filter((id): id is string => id !== null),
  );

  const pending = uncached
    .filter((x) => activeSet.has(x.id))
    .slice(0, MAX_CACHE_PER_RUN);

  if (pending.length === 0) return;

  try {
    await ensureCreativeThumbsBucket();
  } catch {
    return; // can't cache without the bucket — leave Meta URLs in place
  }

  for (const batch of chunked(pending, CACHE_CONCURRENCY)) {
    await Promise.all(
      batch.map(async (item) => {
        try {
          const url = await cacheCreativeThumb({
            orgId: opts.orgId,
            metaCreativeId: item.metaId,
            sourceUrl: item.src,
          });
          if (!url) return;
          await db
            .update(adCreatives)
            .set({ cachedThumbUrl: url })
            .where(eq(adCreatives.id, item.id));
        } catch {
          // best-effort — a single failed rehost shouldn't abort the batch
        }
      }),
    );
  }
}

/**
 * Derive the high-level media kind for a creative from the shape of its
 * `object_story_spec` (or `asset_feed_spec` for dynamic creative). Falls
 * back to 'image' when the spec is empty — pure-image is the most common
 * and safest default for the card grid.
 *
 * Priority (first match wins):
 *   1. top-level video_id            → video
 *   2. object_story_spec.video_data  → video
 *   3. asset_feed_spec.videos[]      → video
 *   4. link_data.child_attachments>1 → carousel
 *   5. asset_feed_spec.images >1     → carousel
 *   6. default                       → image
 */
function deriveMediaKind(c: {
  video_id?: string;
  object_story_spec?: Record<string, unknown>;
  asset_feed_spec?: Record<string, unknown>;
}): "image" | "video" | "carousel" | "reel" {
  if (c.video_id) return "video";

  const oss = c.object_story_spec ?? {};
  const videoData = (oss as { video_data?: unknown }).video_data;
  if (videoData && typeof videoData === "object") return "video";

  const linkData = (oss as { link_data?: { child_attachments?: unknown[] } })
    .link_data;
  if (
    linkData &&
    Array.isArray(linkData.child_attachments) &&
    linkData.child_attachments.length > 1
  ) {
    return "carousel";
  }

  const afs = c.asset_feed_spec ?? {};
  const videos = (afs as { videos?: unknown[] }).videos;
  if (Array.isArray(videos) && videos.length > 0) return "video";
  const images = (afs as { images?: unknown[] }).images;
  if (Array.isArray(images) && images.length > 1) return "carousel";

  return "image";
}
