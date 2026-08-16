"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAppSession } from "@/lib/auth/session";
import {
  addVariant,
  createCopyEntry,
  deleteCopyEntry,
  deleteVariant,
  updateCopyEntry,
  updateVariant,
} from "@/lib/db/queries/copy";

export type ActionState = { ok: boolean; message: string };

const EntrySchema = z.object({
  title: z.string().min(1).max(200),
  painPointSlug: z
    .string()
    .max(80)
    .regex(/^[a-z0-9-]*$/, "lowercase letters, digits, hyphens only")
    .optional()
    .or(z.literal("")),
  audience: z.string().max(200).optional().or(z.literal("")),
  funnelStage: z.string().max(40).optional().or(z.literal("")),
  tagsCsv: z.string().max(500).optional().or(z.literal("")),
  notes: z.string().max(4000).optional().or(z.literal("")),
});

export async function createCopyEntryAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { ok: false, message: "Not signed in." };
  }
  const parsed = EntrySchema.safeParse({
    title: formData.get("title"),
    painPointSlug: formData.get("painPointSlug") ?? "",
    audience: formData.get("audience") ?? "",
    funnelStage: formData.get("funnelStage") ?? "",
    tagsCsv: formData.get("tagsCsv") ?? "",
    notes: formData.get("notes") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const tags = (parsed.data.tagsCsv || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const created = await createCopyEntry({
    orgId: session.orgId,
    title: parsed.data.title,
    painPointSlug: parsed.data.painPointSlug || null,
    audience: parsed.data.audience || null,
    funnelStage: parsed.data.funnelStage || null,
    tags,
    notes: parsed.data.notes || null,
    createdBy: session.userId,
  });
  revalidatePath("/copy");
  redirect(`/copy/${created.id}`);
}

export async function updateCopyEntryAction(
  entryId: string,
  formData: FormData,
): Promise<void> {
  const session = await requireAppSession();
  const parsed = EntrySchema.safeParse({
    title: formData.get("title"),
    painPointSlug: formData.get("painPointSlug") ?? "",
    audience: formData.get("audience") ?? "",
    funnelStage: formData.get("funnelStage") ?? "",
    tagsCsv: formData.get("tagsCsv") ?? "",
    notes: formData.get("notes") ?? "",
  });
  if (!parsed.success) return;
  const tags = (parsed.data.tagsCsv || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  await updateCopyEntry({
    orgId: session.orgId,
    entryId,
    title: parsed.data.title,
    painPointSlug: parsed.data.painPointSlug || null,
    audience: parsed.data.audience || null,
    funnelStage: parsed.data.funnelStage || null,
    tags,
    notes: parsed.data.notes || null,
  });
  revalidatePath(`/copy/${entryId}`);
  revalidatePath("/copy");
}

const VariantSchema = z.object({
  primaryText: z.string().min(1).max(2000),
  headline: z.string().max(120).optional().or(z.literal("")),
  description: z.string().max(300).optional().or(z.literal("")),
  callToAction: z.string().max(40).optional().or(z.literal("")),
});

export async function addVariantAction(
  entryId: string,
  formData: FormData,
): Promise<void> {
  const session = await requireAppSession();
  const parsed = VariantSchema.safeParse({
    primaryText: formData.get("primaryText"),
    headline: formData.get("headline") ?? "",
    description: formData.get("description") ?? "",
    callToAction: formData.get("callToAction") ?? "",
  });
  if (!parsed.success) return;
  await addVariant({
    orgId: session.orgId,
    copyEntryId: entryId,
    primaryText: parsed.data.primaryText,
    headline: parsed.data.headline || null,
    description: parsed.data.description || null,
    callToAction: parsed.data.callToAction || null,
  });
  revalidatePath(`/copy/${entryId}`);
}

export async function updateVariantAction(
  variantId: string,
  entryId: string,
  formData: FormData,
): Promise<void> {
  const session = await requireAppSession();
  const parsed = VariantSchema.safeParse({
    primaryText: formData.get("primaryText"),
    headline: formData.get("headline") ?? "",
    description: formData.get("description") ?? "",
    callToAction: formData.get("callToAction") ?? "",
  });
  if (!parsed.success) return;
  await updateVariant({
    orgId: session.orgId,
    variantId,
    primaryText: parsed.data.primaryText,
    headline: parsed.data.headline || null,
    description: parsed.data.description || null,
    callToAction: parsed.data.callToAction || null,
  });
  revalidatePath(`/copy/${entryId}`);
}

export async function deleteVariantAction(
  variantId: string,
  entryId: string,
): Promise<void> {
  const session = await requireAppSession();
  await deleteVariant({ orgId: session.orgId, variantId });
  revalidatePath(`/copy/${entryId}`);
}

export async function deleteCopyEntryAction(entryId: string): Promise<void> {
  const session = await requireAppSession();
  await deleteCopyEntry({ orgId: session.orgId, entryId });
  revalidatePath("/copy");
  redirect("/copy");
}
