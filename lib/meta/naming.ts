/**
 * Campaign / ad-set name parsing for the GT1 naming convention.
 *
 * Names follow a dash-delimited template, e.g.
 *   campaign: "AIA - 1_Cold - Lead - GT1 - FB - MY - Interest: Apple Inc."
 *   ad set:   "Interest: Apple Inc. - 21-65+ - MY - GT1 - Event: LDP - FB - AIA - AD01B - IMAGE: 2CC - COPY: Andi01"
 *
 * These helpers extract the temperature tier + platform tokens used to bucket
 * sibling GT1 campaigns, and rewrite a source ad-set name to a destination
 * campaign's interest (the parity-sync card needs the new ad set named for the
 * campaign it lands in, not the campaign it came from).
 */

import { extractAdCode } from "@/lib/meta/actions";

export type Platform = "FB" | "IG" | "Other";

/** Which placement a campaign targets, read from its " - FB - " / " - IG - " token. */
export function platformFromCampaignName(name: string): Platform {
  if (/ - FB - /i.test(name)) return "FB";
  if (/ - IG - /i.test(name)) return "IG";
  return "Other";
}

/**
 * The temperature tier token (e.g. "1_Cold", "2_Warm", "2_Cold"). Returns the
 * literal token so different projects can use different numbering without
 * colliding; "Other" when absent.
 */
export function temperatureFromCampaignName(name: string): string {
  const m = name.match(/ - (\d+_[A-Za-z]+) - /);
  return m ? m[1] : "Other";
}

const DELIM = " - ";

/**
 * Rewrite `sourceName` so it reads as if it belonged to the destination
 * campaign, by splicing the destination's prefix (interest / age / geo / GT /
 * platform / account) onto the source's tail (ad-code / creative / copy).
 *
 * Splits both names on " - " and joins the destination segments BEFORE its
 * ad-code with the source segments FROM its ad-code onward. Split-then-rejoin
 * on the same delimiter is lossless, so creative labels that themselves
 * contain " - " survive. Falls back to swapping only the leading interest
 * segment when either name lacks an extractable ad-code.
 *
 * Returns null only when inputs are empty.
 */
export function spliceAdSetName(
  destReferenceName: string,
  sourceName: string,
): string | null {
  if (!destReferenceName || !sourceName) return null;

  const destSegs = destReferenceName.split(DELIM);
  const srcSegs = sourceName.split(DELIM);

  const destCode = extractAdCode(destReferenceName);
  const srcCode = extractAdCode(sourceName);
  const destCodeIdx = destCode ? destSegs.lastIndexOf(destCode) : -1;
  const srcCodeIdx = srcCode ? srcSegs.lastIndexOf(srcCode) : -1;

  if (destCodeIdx >= 0 && srcCodeIdx >= 0) {
    return [...destSegs.slice(0, destCodeIdx), ...srcSegs.slice(srcCodeIdx)].join(
      DELIM,
    );
  }

  // Fallback: swap just the leading interest label so the name at least
  // carries the destination interest.
  if (srcSegs.length > 1) {
    return [destSegs[0], ...srcSegs.slice(1)].join(DELIM);
  }
  return destSegs[0];
}
