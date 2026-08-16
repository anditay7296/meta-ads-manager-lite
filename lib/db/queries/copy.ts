import { db, schema } from "@/lib/db/client";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

const { copyEntries, copyVariants } = schema;

export type CopyEntryRow = typeof copyEntries.$inferSelect;
export type CopyVariantRow = typeof copyVariants.$inferSelect;

export type CopyEntryWithCount = CopyEntryRow & { variantCount: number };

export async function listCopyEntries(opts: {
  orgId: string;
  search?: string | null;
  tag?: string | null;
}): Promise<CopyEntryWithCount[]> {
  const conds = [eq(copyEntries.orgId, opts.orgId)];
  if (opts.tag) {
    conds.push(sql`${opts.tag} = ANY(${copyEntries.tags})`);
  }
  if (opts.search) {
    const term = `%${opts.search.toLowerCase()}%`;
    conds.push(
      sql`(lower(${copyEntries.title}) like ${term} or lower(coalesce(${copyEntries.painPointSlug},'')) like ${term} or lower(coalesce(${copyEntries.audience},'')) like ${term})`,
    );
  }
  const entries = await db
    .select()
    .from(copyEntries)
    .where(and(...conds))
    .orderBy(desc(copyEntries.updatedAt));

  if (entries.length === 0) return [];
  const ids = entries.map((e) => e.id);
  const counts = await db
    .select({
      entryId: copyVariants.copyEntryId,
      count: sql<number>`count(*)::int`,
    })
    .from(copyVariants)
    .where(inArray(copyVariants.copyEntryId, ids))
    .groupBy(copyVariants.copyEntryId);
  const map = new Map(counts.map((r) => [r.entryId, r.count]));
  return entries.map((e) => ({ ...e, variantCount: map.get(e.id) ?? 0 }));
}

export async function getCopyEntry(opts: {
  orgId: string;
  entryId: string;
}): Promise<{ entry: CopyEntryRow; variants: CopyVariantRow[] } | null> {
  const [entry] = await db
    .select()
    .from(copyEntries)
    .where(
      and(eq(copyEntries.orgId, opts.orgId), eq(copyEntries.id, opts.entryId)),
    )
    .limit(1);
  if (!entry) return null;
  const variants = await db
    .select()
    .from(copyVariants)
    .where(eq(copyVariants.copyEntryId, entry.id))
    .orderBy(asc(copyVariants.variantNumber));
  return { entry, variants };
}

export type CreateEntryInput = {
  orgId: string;
  title: string;
  painPointSlug?: string | null;
  audience?: string | null;
  funnelStage?: string | null;
  tags?: string[];
  notes?: string | null;
  createdBy: string;
};

export async function createCopyEntry(
  input: CreateEntryInput,
): Promise<CopyEntryRow> {
  const [row] = await db
    .insert(copyEntries)
    .values({
      orgId: input.orgId,
      title: input.title.trim(),
      painPointSlug: input.painPointSlug?.trim() || null,
      audience: input.audience?.trim() || null,
      funnelStage: input.funnelStage?.trim() || null,
      tags: input.tags ?? [],
      notes: input.notes?.trim() || null,
      createdBy: input.createdBy,
    })
    .returning();
  return row;
}

export type UpdateEntryInput = Partial<
  Omit<CreateEntryInput, "orgId" | "createdBy">
> & {
  orgId: string;
  entryId: string;
};

export async function updateCopyEntry(input: UpdateEntryInput): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: sql`now()` };
  if (input.title !== undefined) set.title = input.title.trim();
  if (input.painPointSlug !== undefined)
    set.painPointSlug = input.painPointSlug?.trim() || null;
  if (input.audience !== undefined) set.audience = input.audience?.trim() || null;
  if (input.funnelStage !== undefined)
    set.funnelStage = input.funnelStage?.trim() || null;
  if (input.tags !== undefined) set.tags = input.tags;
  if (input.notes !== undefined) set.notes = input.notes?.trim() || null;
  await db
    .update(copyEntries)
    .set(set)
    .where(
      and(eq(copyEntries.orgId, input.orgId), eq(copyEntries.id, input.entryId)),
    );
}

export async function deleteCopyEntry(opts: {
  orgId: string;
  entryId: string;
}): Promise<void> {
  await db
    .delete(copyEntries)
    .where(
      and(eq(copyEntries.orgId, opts.orgId), eq(copyEntries.id, opts.entryId)),
    );
}

export type AddVariantInput = {
  orgId: string;
  copyEntryId: string;
  primaryText: string;
  headline?: string | null;
  description?: string | null;
  callToAction?: string | null;
};

export async function addVariant(
  input: AddVariantInput,
): Promise<CopyVariantRow> {
  // Determine next variant_number for this entry.
  const [maxRow] = await db
    .select({
      max: sql<number>`coalesce(max(${copyVariants.variantNumber}), 0)`,
    })
    .from(copyVariants)
    .where(eq(copyVariants.copyEntryId, input.copyEntryId));
  const next = (maxRow?.max ?? 0) + 1;
  const [row] = await db
    .insert(copyVariants)
    .values({
      orgId: input.orgId,
      copyEntryId: input.copyEntryId,
      variantNumber: next,
      primaryText: input.primaryText.trim(),
      headline: input.headline?.trim() || null,
      description: input.description?.trim() || null,
      callToAction: input.callToAction?.trim() || null,
    })
    .returning();
  return row;
}

export type UpdateVariantInput = {
  orgId: string;
  variantId: string;
  primaryText: string;
  headline?: string | null;
  description?: string | null;
  callToAction?: string | null;
};

export async function updateVariant(input: UpdateVariantInput): Promise<void> {
  await db
    .update(copyVariants)
    .set({
      primaryText: input.primaryText.trim(),
      headline: input.headline?.trim() || null,
      description: input.description?.trim() || null,
      callToAction: input.callToAction?.trim() || null,
    })
    .where(
      and(
        eq(copyVariants.orgId, input.orgId),
        eq(copyVariants.id, input.variantId),
      ),
    );
}

export async function deleteVariant(opts: {
  orgId: string;
  variantId: string;
}): Promise<void> {
  await db
    .delete(copyVariants)
    .where(
      and(
        eq(copyVariants.orgId, opts.orgId),
        eq(copyVariants.id, opts.variantId),
      ),
    );
}

