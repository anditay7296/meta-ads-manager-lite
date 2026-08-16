/**
 * The GT1 campaign scaffold Andi deploys into a freshly-onboarded, empty ad
 * account. Mirrors the AIA (MY) reference campaign `120245040177070502`:
 *   "AIA - 1_Cold - Lead - GT1 - FB - MY - LAL"  (OUTCOME_LEADS / AUCTION / ABO)
 *
 * Campaign SHELL ONLY — no ad sets. The GT1 ad set optimizes for
 * OFFSITE_CONVERSIONS against a pixel and targets LAL audiences, both of which
 * are per-account assets that must be shared cross-account first (the Jackson
 * Design pixel + AIA (MY) lookalikes). Building the ad set is a deliberate
 * follow-up; this file scaffolds the campaign the operator approves in /agent.
 *
 * Consumed by:
 *   - lib/inngest/empty-account-scaffold.ts   (detect empty account → propose)
 *   - app/(app)/agent/[id]/approval-actions.ts (approve → createCampaign)
 */

/** Fallback naming code when a project has no `adNamingCode` set. */
export const GT1_SCAFFOLD_DEFAULT_CODE = "AIA";

/**
 * Build the GT1 campaign name for a given project naming code. Keeps the exact
 * segment order the rules engine + keepers pattern-match on ("- GT1 -").
 */
export function gt1ScaffoldCampaignName(adNamingCode?: string | null): string {
  const code = (adNamingCode?.trim() || GT1_SCAFFOLD_DEFAULT_CODE).trim();
  return `${code} - 1_Cold - Lead - GT1 - FB - MY - LAL`;
}

/**
 * The exact `createCampaign` fields for the GT1 shell. No budget is passed, so
 * this is ABO — `MetaClient.createCampaign` defaults
 * `is_adset_budget_sharing_enabled: false`, matching every AIA (MY) GT1
 * campaign. `status` is forced to PAUSED inside `createCampaign`.
 */
export function gt1ScaffoldCampaignFields(adNamingCode?: string | null): {
  name: string;
  objective: string;
  special_ad_categories: string[];
  buying_type: string;
} {
  return {
    name: gt1ScaffoldCampaignName(adNamingCode),
    objective: "OUTCOME_LEADS",
    special_ad_categories: [],
    buying_type: "AUCTION",
  };
}
