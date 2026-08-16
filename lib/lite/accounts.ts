import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";

/**
 * The whole point of "Lite": this app manages exactly two Meta ad accounts.
 *
 *   act_1690421202260749 — AI Agency 02
 *   act_1386521543403841 — AI Agency 05
 *
 * Override with LITE_AD_ACCOUNT_IDS (comma-separated, `act_` prefix optional).
 *
 * The database is already narrow — bootstrap provisions one project holding
 * only these accounts, so every existing project-scoped query is correct
 * without modification. This module is the belt-and-braces guard on top: the
 * sync path filters through it, so an account that somehow lands in the DB
 * (a stray Meta inventory refresh, a hand-written insert) never gets synced
 * and never shows up in the UI.
 */
const DEFAULT_ACCOUNT_IDS = [
  "act_1690421202260749",
  "act_1386521543403841",
] as const;

function normalize(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("act_") ? trimmed : `act_${trimmed}`;
}

function parseEnv(): string[] | null {
  const raw = process.env.LITE_AD_ACCOUNT_IDS?.trim();
  if (!raw) return null;
  const ids = raw.split(",").map(normalize).filter(Boolean);
  return ids.length > 0 ? ids : null;
}

/** Meta account ids (`act_…`) this app is allowed to touch. */
export const LITE_AD_ACCOUNT_IDS: string[] =
  parseEnv() ?? [...DEFAULT_ACCOUNT_IDS];

export function isLiteAdAccount(metaAccountId: string | null | undefined): boolean {
  if (!metaAccountId) return false;
  return LITE_AD_ACCOUNT_IDS.includes(normalize(metaAccountId));
}

/**
 * Keep only the allowlisted entries of a list of ad accounts. Takes anything
 * carrying a `metaAccountId`, so it composes with the row shapes returned by
 * the sync + manager queries.
 */
export function filterToLiteAccounts<T extends { metaAccountId: string }>(
  rows: T[],
): T[] {
  return rows.filter((row) => isLiteAdAccount(row.metaAccountId));
}

/**
 * Resolve the allowlist to `ad_accounts.id` UUIDs for an org. Returns an empty
 * array when nothing is provisioned yet — callers should treat that as "no
 * accounts to work on", not as an error.
 */
export async function getLiteAdAccountUuids(orgId: string): Promise<string[]> {
  const rows = await db
    .select({ id: schema.adAccounts.id })
    .from(schema.adAccounts)
    .where(
      and(
        eq(schema.adAccounts.orgId, orgId),
        inArray(schema.adAccounts.metaAccountId, LITE_AD_ACCOUNT_IDS),
      ),
    );
  return rows.map((r) => r.id);
}
