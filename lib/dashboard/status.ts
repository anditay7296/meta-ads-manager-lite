/**
 * Phase 1 traffic-light heuristic — must stay free of server-only imports
 * (no `postgres`, no Supabase service role) so it can be used inside Client
 * Components like AdCard.
 *
 * Phase 3+ will swap this for live evaluation of the user's actual rule
 * definitions, but for now it mirrors the spirit of Andi's RM45/2 + RM75/2
 * thresholds so dashboard cards + filters agree.
 */

type AdLite = {
  effectiveStatus: string | null;
  spend: number;
  results: number;
};

export type AdStatus = "paused" | "red" | "yellow" | "green" | "neutral";

export function adStatus(ad: AdLite): AdStatus {
  if (
    ad.effectiveStatus === "PAUSED" ||
    ad.effectiveStatus === "CAMPAIGN_PAUSED" ||
    ad.effectiveStatus === "ADSET_PAUSED" ||
    ad.effectiveStatus === "DISAPPROVED" ||
    ad.effectiveStatus === "ARCHIVED"
  ) {
    return "paused";
  }
  if (ad.spend === 0) return "neutral";
  if (ad.spend > 45 && ad.results < 2) return "red";
  if (ad.spend > 25 && ad.results < 1) return "yellow";
  return "green";
}
