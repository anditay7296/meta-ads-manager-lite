import type { MetaAdLibraryAd } from "./types";

/**
 * UI tile shape used by /creatives/brands and /creatives/discover. Maps a
 * raw `/ads_archive` row into a render-friendly object: one preview URL,
 * one caption, derived running-days, friendly platform list. The result
 * is intentionally similar to `CreativeCardData` from queries/creatives
 * so the components can be visually consistent, but keep external-only
 * fields (snapshot_url, archive_id) intact for save-to-board.
 *
 * Lossy conversions:
 *   - `ad_creative_bodies` is an array (multi-creative ads). We surface
 *     the first body as `caption` and stash the full array on `extraBodies`
 *     so the detail panel can display all variants.
 *   - `ad_snapshot_url` is a *page URL* (with our access token embedded!),
 *     not an image URL, and Meta blocks framing it. We therefore never
 *     forward it to the client. Still-image previews come from the
 *     server-side scrape route `/api/creatives/adlib-thumb` (see
 *     `lib/meta/snapshot-thumb.ts`), and outbound links use the public
 *     Ad Library page URL instead.
 */
export type AdLibraryTile = {
  archiveId: string;
  pageId: string | null;
  pageName: string;
  caption: string | null;
  /** Additional creative-body variants beyond the first one. */
  extraBodies: string[];
  title: string | null;
  description: string | null;
  linkCaption: string | null;
  /** Public, token-free Meta Ad Library page for this ad. */
  libraryUrl: string;
  /** Internal same-origin route that 302s to the creative image. */
  thumbUrl: string;
  deliveryStart: Date | null;
  deliveryStop: Date | null;
  runningDays: number | null;
  languages: string[];
  /** Cleaned-up platform labels: 'Facebook', 'Instagram', etc. */
  platforms: string[];
  countries: string[];
};

export function adLibraryRowToTile(row: MetaAdLibraryAd): AdLibraryTile {
  const bodies = row.ad_creative_bodies ?? [];
  const titles = row.ad_creative_link_titles ?? [];
  const descriptions = row.ad_creative_link_descriptions ?? [];
  const captions = row.ad_creative_link_captions ?? [];
  const start = row.ad_delivery_start_time
    ? new Date(row.ad_delivery_start_time)
    : null;
  const stop = row.ad_delivery_stop_time
    ? new Date(row.ad_delivery_stop_time)
    : null;
  const endRef = stop ?? new Date();
  const runningDays =
    start !== null
      ? Math.max(
          0,
          Math.floor((endRef.getTime() - start.getTime()) / 86_400_000),
        )
      : null;
  return {
    archiveId: row.id,
    pageId: row.page_id ?? null,
    pageName: row.page_name ?? "Unknown page",
    caption: bodies[0] ?? null,
    extraBodies: bodies.slice(1),
    title: titles[0] ?? null,
    description: descriptions[0] ?? null,
    linkCaption: captions[0] ?? null,
    libraryUrl: adLibraryPublicUrl(row.id),
    thumbUrl: adLibraryThumbRoute(row.id),
    deliveryStart: start,
    deliveryStop: stop,
    runningDays,
    languages: row.languages ?? [],
    platforms: (row.publisher_platforms ?? []).map(prettifyPlatform),
    countries: (row.target_locations ?? [])
      .map((l) => l.name)
      .filter((n): n is string => !!n),
  };
}

/**
 * Build the `externalRef` JSON used by `board_items` for an ad library
 * save. The shape is what `getBoardWithItems` already knows how to render
 * via `BoardItemExternalRef`.
 */
export function tileToExternalRef(tile: AdLibraryTile): {
  source: "ad_library";
  archiveId: string;
  pageId: string | null;
  pageName: string;
  caption: string | null;
  snapshotUrl: string | null;
  thumbnailUrl: string | null;
  link: string | null;
} {
  return {
    source: "ad_library",
    archiveId: tile.archiveId,
    pageId: tile.pageId,
    pageName: tile.pageName,
    caption: tile.caption,
    // `snapshotUrl` (legacy key name in stored board_items JSON) now holds
    // the public token-free Ad Library page — used as the outbound link.
    // `thumbnailUrl` is the internal scrape route, safe to render in <img>.
    snapshotUrl: tile.libraryUrl,
    thumbnailUrl: tile.thumbUrl,
    link: tile.linkCaption,
  };
}

/** Public, token-free Ad Library page for one archive ad. */
export function adLibraryPublicUrl(archiveId: string): string {
  return `https://www.facebook.com/ads/library/?id=${archiveId}`;
}

/**
 * Public Ad Library *website* search view — page-scoped when a Page ID
 * is known, keyword search otherwise.
 *
 * This is the escape hatch for the API's transparency scope: Meta's
 * `/ads_archive` API only exposes political ads plus commercial ads that
 * delivered to the EU/UK (DSA), so local-only advertisers (e.g. MY-only
 * pages) return zero rows via the API while this website view shows
 * everything. Verified empirically 2026-07-06: every API row returned
 * for a MY query carried `eu_total_reach ≥ 1` / EU target_locations,
 * while MY-only pages with ~31 and ~170 live ads on the website returned
 * 0 and 1 rows via the API (v21 and v23 alike). The website itself
 * bot-challenges server-side fetches (403 + JS challenge), so linking
 * the operator's own logged-in browser out to it is the only sanctioned
 * path to that data.
 */
export function adLibraryWebsiteSearchUrl(opts: {
  pageId?: string | null;
  searchTerms?: string;
  country?: string;
}): string {
  const params = new URLSearchParams({
    active_status: "active",
    ad_type: "all",
    country: (opts.country ?? "MY").toUpperCase(),
    media_type: "all",
  });
  if (opts.pageId) {
    params.set("view_all_page_id", opts.pageId);
    params.set("search_type", "page");
  } else {
    params.set("q", opts.searchTerms ?? "");
    params.set("search_type", "keyword_unordered");
  }
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

/** Same-origin route that resolves + redirects to the creative image. */
export function adLibraryThumbRoute(archiveId: string): string {
  return `/api/creatives/adlib-thumb?archiveId=${archiveId}`;
}

function prettifyPlatform(p: string): string {
  switch (p.toLowerCase()) {
    case "facebook":
      return "Facebook";
    case "instagram":
      return "Instagram";
    case "messenger":
      return "Messenger";
    case "audience_network":
      return "Audience Network";
    case "threads":
      return "Threads";
    default:
      return p;
  }
}

/**
 * Country options for the Brands / Discover search inputs. Keep it short
 * — Andi's traffic is MY-dominant; the rest are common SE-Asia + EN
 * markets to spy on. Easy to extend.
 */
/**
 * Platform filter options for Discover. Values are the uppercase enums
 * Meta's `/ads_archive` accepts for `publisher_platforms`. "ALL" means
 * omit the param. (No TikTok here — Meta's public library only covers
 * Meta surfaces; tools like Foreplay index TikTok from a separate source.)
 */
export const AD_LIBRARY_PLATFORM_OPTIONS: Array<{
  value: string;
  label: string;
}> = [
  { value: "ALL", label: "All platforms" },
  { value: "FACEBOOK", label: "Facebook" },
  { value: "INSTAGRAM", label: "Instagram" },
  { value: "MESSENGER", label: "Messenger" },
  { value: "AUDIENCE_NETWORK", label: "Audience Network" },
  { value: "THREADS", label: "Threads" },
];

/** Status filter — maps directly to Meta's `ad_active_status` enum. */
export const AD_LIBRARY_STATUS_OPTIONS: Array<{
  value: "ACTIVE" | "ALL" | "INACTIVE";
  label: string;
}> = [
  { value: "ACTIVE", label: "Active only" },
  { value: "ALL", label: "Active + inactive" },
  { value: "INACTIVE", label: "Inactive only" },
];

/** Maps to Meta's `media_type` enum on `/ads_archive`. */
export const AD_LIBRARY_MEDIA_TYPE_OPTIONS: Array<{
  value: string;
  label: string;
}> = [
  { value: "all", label: "All formats" },
  { value: "image", label: "Image" },
  { value: "video", label: "Video" },
  { value: "meme", label: "Meme" },
];

/**
 * Curated language list for the Discover filter — Andi's SEA/EN markets,
 * not the full ISO 639-1 table. Values are what Meta's `languages` param
 * expects.
 */
export const AD_LIBRARY_LANGUAGE_OPTIONS: Array<{
  value: string;
  label: string;
}> = [
  { value: "ALL", label: "Any language" },
  { value: "en", label: "English" },
  { value: "ms", label: "Malay" },
  { value: "zh", label: "Chinese" },
  { value: "id", label: "Indonesian" },
  { value: "th", label: "Thai" },
  { value: "vi", label: "Vietnamese" },
  { value: "tl", label: "Tagalog" },
  { value: "ta", label: "Tamil" },
];

export type AdLibrarySort = "relevance" | "newest" | "oldest" | "longest";

/** Sort options mirroring Foreplay's Discovery dropdown. */
export const AD_LIBRARY_SORT_OPTIONS: Array<{
  value: AdLibrarySort;
  label: string;
}> = [
  { value: "relevance", label: "Most relevant" },
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "longest", label: "Longest running" },
];

/**
 * Order tiles client-side. Meta's `/ads_archive` has no sort parameter,
 * so "relevance" keeps API order and the rest sort on delivery-start /
 * running-days. Stable: ties keep API (relevance) order.
 */
export function sortAdLibraryTiles(
  tiles: AdLibraryTile[],
  sort: AdLibrarySort,
): AdLibraryTile[] {
  if (sort === "relevance") return tiles;
  const startMs = (t: AdLibraryTile) => t.deliveryStart?.getTime() ?? 0;
  const sorted = [...tiles];
  switch (sort) {
    case "newest":
      sorted.sort((a, b) => startMs(b) - startMs(a));
      break;
    case "oldest":
      sorted.sort((a, b) => startMs(a) - startMs(b));
      break;
    case "longest":
      sorted.sort((a, b) => (b.runningDays ?? -1) - (a.runningDays ?? -1));
      break;
  }
  return sorted;
}

/**
 * Deep links into each non-Meta platform's own public ad library,
 * pre-filled with the same keyword where the platform's URL scheme
 * actually supports it. We don't scrape or index TikTok/LinkedIn/
 * YouTube ourselves:
 *   - TikTok's official Commercial Content Library API is restricted to
 *     approved academic researchers, not commercial tools, and its
 *     EEA-only sibling doesn't cover Andi's MY/SEA market anyway. Its
 *     consumer-facing `library.tiktok.com/ads` tool *does* cover all
 *     countries and takes a keyword — params verified by driving the
 *     real page (`adv_name` + `query_type=1`, not the more-obvious-
 *     looking `search_key`).
 *   - LinkedIn has no public API and has stated no plans to build one;
 *     `linkedin.com/ad-library/search?keyword=` is the only sanctioned
 *     path and does prefill — verified live.
 *   - Google's Ads Transparency Center has no keyword-prefill URL
 *     param at all (verified live) — it's an advertiser-name/domain
 *     lookup tool, not a keyword-in-ad-copy search like the others, so
 *     we can only link to its homepage.
 */
export function buildExternalAdLibraryLinks(
  query: string,
  country: string,
): { tiktok: string; linkedin: string; youtube: string } {
  const q = encodeURIComponent(query);
  return {
    tiktok: `https://library.tiktok.com/ads?region=all&adv_name=${q}&query_type=1&sort_type=last_shown_date,desc`,
    linkedin: `https://www.linkedin.com/ad-library/search?keyword=${q}&countries=${encodeURIComponent(country)}`,
    youtube: `https://adstransparency.google.com/?region=anywhere`,
  };
}

export const AD_LIBRARY_COUNTRY_OPTIONS: Array<{ code: string; label: string }> =
  [
    { code: "MY", label: "Malaysia" },
    { code: "SG", label: "Singapore" },
    { code: "ID", label: "Indonesia" },
    { code: "TH", label: "Thailand" },
    { code: "PH", label: "Philippines" },
    { code: "VN", label: "Vietnam" },
    { code: "TW", label: "Taiwan" },
    { code: "HK", label: "Hong Kong" },
    { code: "AU", label: "Australia" },
    { code: "GB", label: "United Kingdom" },
    { code: "US", label: "United States" },
  ];
