// Meta URL-parameter macros — substituted by Meta at impression time, so they
// pass to the Marketing API as literal text inside the destination link. Each
// boost ad therefore self-tags with its own adset / campaign / ad attribution.
// Source: Meta Ads Help Center → "URL parameters".
export const META_UTM_TEMPLATE =
  "utm_source=fb_ad&utm_medium={{adset.name}}&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&campaign_id={{campaign.id}}";

/**
 * Append the standard Meta UTM template to a base URL.
 * - Uses `?` when the base has no query string, `&` otherwise.
 * - Preserves a trailing `#fragment`.
 * - Does NOT url-encode the `{{…}}` macros — Meta needs them literal.
 *
 * Pure + dependency-free so it's safe to import from client components.
 */
export function appendUtmTemplate(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return trimmed;
  const hashIdx = trimmed.indexOf("#");
  const hash = hashIdx >= 0 ? trimmed.slice(hashIdx) : "";
  const beforeHash = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
  const cleaned = beforeHash.replace(/[?&]+$/, "");
  const sep = cleaned.includes("?") ? "&" : "?";
  return `${cleaned}${sep}${META_UTM_TEMPLATE}${hash}`;
}
