/**
 * Server-side thumbnail extraction for Meta Ad Library ads.
 *
 * `ad_snapshot_url` points at an HTML page (`/ads/archive/render_ad/`)
 * that (a) sends `X-Frame-Options: DENY`, so it can never be iframed,
 * and (b) since ~2025 ships as a JS shell with no creative markup — the
 * `AdLibraryV3DemoAd` component fetches the ad content via a Relay
 * GraphQL query at runtime. So we replicate that exact flow server-side
 * (keeping the access token off the client):
 *
 *   1. GET the snapshot shell (token-authorized, no cookies) and pull
 *      the per-response `LSD` CSRF token out of the HTML.
 *      NB: send *no* browser-ish headers here — a partial browser
 *      header set (UA + Accept-Language) trips Meta's bot check and
 *      returns 400, while a plain fetch returns 200.
 *   2. POST `/api/graphql/` with that LSD + the pinned docID for
 *      `AdLibraryV3DemoAdContentQuery` (variables: `{ adID }`). The
 *      response JSON carries the creative's real CDN URLs.
 *
 * The extracted fbcdn URLs are signed and expire, so hits are cached a
 * few hours only and re-scraped after that. If thumbnails ever go dark
 * across the board, suspect the docID rotated: re-derive it by fetching
 * the shell's JS bundles and grepping for
 * `AdLibraryV3DemoAdContentQuery_facebookRelayOperation",[],(...){a.exports="<docID>"`.
 */

const HIT_TTL_MS = 6 * 60 * 60 * 1000; // 6h — well under fbcdn URL lifetime
const MISS_TTL_MS = 10 * 60 * 1000; // 10min — don't hammer Meta on dead ads
const CACHE_MAX = 2000;

/**
 * Relay persisted-query ID for `AdLibraryV3DemoAdContentQuery` (mined
 * from Meta's `EZrCePanS58.js` bundle, 2026-07-02). Old docIDs keep
 * working for months after rotation; override via env if it ever dies.
 */
const DEMO_AD_CONTENT_DOC_ID =
  process.env.ADLIB_DEMO_AD_DOC_ID ?? "32740921038887979";

type CacheEntry = { url: string | null; expiresAt: number };
const cache = new Map<string, CacheEntry>();

/**
 * Preference order for the image keys in the GraphQL response.
 * `resized_image_url` is the feed-sized still; `original_image_url` the
 * full asset (also present per-card on carousels — the regex naturally
 * grabs the first card); `video_preview_image_url` covers video ads.
 */
const IMAGE_KEYS = [
  "resized_image_url",
  "original_image_url",
  "video_preview_image_url",
  "watermarked_resized_image_url",
] as const;

/** Pull the first usable creative-image URL out of the GraphQL JSON. */
export function extractSnapshotImageUrl(text: string): string | null {
  for (const key of IMAGE_KEYS) {
    const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)+)"`, "g");
    for (const m of text.matchAll(re)) {
      try {
        // Re-quote so JSON.parse resolves \/ and \uXXXX escapes.
        const url = JSON.parse(`"${m[1]}"`) as string;
        if (url.startsWith("https://")) return url;
      } catch {
        // malformed escape — try the next match
      }
    }
  }
  return null;
}

/**
 * Resolve the still-image thumbnail for one archive ad. Returns null when
 * nothing is extractable (deleted ad, text-only ad, or Meta changed their
 * plumbing). Results (including misses) are cached in-module; on Vercel
 * each warm lambda keeps its own cache, which is fine — this is an
 * optimization, not a correctness requirement.
 */
export async function resolveAdLibraryThumb(
  archiveId: string,
  accessToken: string,
): Promise<string | null> {
  const hit = cache.get(archiveId);
  if (hit && hit.expiresAt > Date.now()) return hit.url;

  let url: string | null = null;
  try {
    // Step 1 — snapshot shell → LSD token. Deliberately bare fetch (see
    // module doc): custom browser headers here cause a 400.
    const shellRes = await fetch(
      `https://www.facebook.com/ads/archive/render_ad/?id=${encodeURIComponent(
        archiveId,
      )}&access_token=${encodeURIComponent(accessToken)}`,
      { redirect: "follow", signal: AbortSignal.timeout(10_000) },
    );
    const lsd = shellRes.ok
      ? (await shellRes.text()).match(/"LSD"[^}]*"token":"([^"]+)"/)?.[1]
      : undefined;

    if (lsd) {
      // Step 2 — the same Relay query the shell's JS would fire.
      const body = new URLSearchParams({
        lsd,
        fb_api_caller_class: "RelayModern",
        fb_api_req_friendly_name: "AdLibraryV3DemoAdContentQuery",
        variables: JSON.stringify({ adID: archiveId }),
        server_timestamps: "true",
        doc_id: DEMO_AD_CONTENT_DOC_ID,
      });
      const gqlRes = await fetch("https://www.facebook.com/api/graphql/", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-fb-lsd": lsd,
          "x-fb-friendly-name": "AdLibraryV3DemoAdContentQuery",
        },
        body: body.toString(),
        signal: AbortSignal.timeout(10_000),
      });
      if (gqlRes.ok) {
        url = extractSnapshotImageUrl(await gqlRes.text());
      }
    }
  } catch {
    // network/timeout — treated as a miss, retried after MISS_TTL
  }

  if (cache.size >= CACHE_MAX) {
    // Drop the oldest-inserted entry (Map preserves insertion order).
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(archiveId, {
    url,
    expiresAt: Date.now() + (url ? HIT_TTL_MS : MISS_TTL_MS),
  });
  return url;
}
