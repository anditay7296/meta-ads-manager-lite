"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAppSession } from "@/lib/auth/session";
import { runVariationFactory, type VariationResult } from "@/lib/meta/actions";
import {
  createSignedAssetUploads,
  ensurePostAssetsBucket,
  uploadPostAsset,
  type SignedAssetUpload,
} from "@/lib/storage";
import { db, schema } from "@/lib/db/client";
import { and, eq, sql } from "drizzle-orm";
import { inngest } from "@/lib/inngest/client";
import type { FactoryRunItem } from "@/lib/inngest/factory-run";

const CTA_VALUES = [
  "LEARN_MORE",
  "SHOP_NOW",
  "SIGN_UP",
  "GET_OFFER",
  "BOOK_TRAVEL",
  "DOWNLOAD",
  "CONTACT_US",
  "SUBSCRIBE",
  "MESSAGE_PAGE",
  "WHATSAPP_MESSAGE",
] as const;

const SpecSchema = z
  .object({
    pain_point_slug: z
      .string()
      .min(1)
      .regex(
        /^[a-z0-9-]+$/,
        "pain_point_slug must be lowercase letters/digits/hyphens only",
      ),
    variation_number: z.number().int().min(1),
    post_id: z.string().min(1).optional(),
    image_url: z.string().url().optional(),
    primary_text: z.string().max(2200).optional(),
    headline: z.string().max(120).optional(),
    description: z.string().max(300).optional(),
    link_url: z.string().url().optional(),
    call_to_action: z.enum(CTA_VALUES).optional(),
  })
  .refine((v) => v.post_id || v.image_url, {
    message: "each spec needs either post_id or image_url",
  })
  .refine(
    (v) => (v.image_url ? Boolean(v.primary_text) : true),
    { message: "image_url specs require primary_text" },
  );

const InputSchema = z.union([SpecSchema, z.array(SpecSchema)]);

export type FactoryRunResult =
  | { ok: true; created: number; failed: number; results: VariationResult[] }
  | { ok: false; message: string };

export async function runFactoryAction(formData: FormData): Promise<FactoryRunResult> {
  const adSetId = String(formData.get("adSetId") ?? "");
  const pageId = String(formData.get("pageId") ?? "");
  const json = String(formData.get("json") ?? "").trim();
  if (!adSetId || !pageId || !json) {
    return { ok: false, message: "Missing required fields." };
  }

  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { ok: false, message: "Not signed in." };
  }

  // ── Optional asset uploads: drag-drop image files. Each gets pushed to
  // Supabase Storage and the resulting public URL is mapped by filename.
  // Specs can then reference `image_url: "uploaded:filename.jpg"` to skip
  // hosting their own CDN.
  const uploadedByName = new Map<string, string>();
  const assetFiles = formData.getAll("assetFiles");
  const realFiles = assetFiles.filter(
    (f): f is File => f instanceof File && f.size > 0,
  );
  if (realFiles.length > 0) {
    try {
      await ensurePostAssetsBucket();
      for (const f of realFiles) {
        const up = await uploadPostAsset({
          orgId: session.orgId,
          userId: session.userId,
          file: f,
        });
        uploadedByName.set(f.name, up.publicUrl);
      }
    } catch (err) {
      return {
        ok: false,
        message: `Asset upload failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return {
      ok: false,
      message: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const validated = InputSchema.safeParse(parsed);
  if (!validated.success) {
    const issue = validated.error.issues[0];
    return {
      ok: false,
      message: `Schema error at ${issue.path.join(".") || "root"}: ${issue.message}`,
    };
  }
  const specsRaw = Array.isArray(validated.data) ? validated.data : [validated.data];
  if (specsRaw.length === 0) return { ok: false, message: "No specs to process." };

  // Resolve `image_url: "uploaded:<filename>"` against the file map.
  let specs;
  try {
    specs = specsRaw.map((s) => {
      if (s.image_url?.startsWith("uploaded:")) {
        const name = s.image_url.slice("uploaded:".length);
        const resolved = uploadedByName.get(name);
        if (!resolved) {
          throw new Error(
            `Spec references uploaded:${name} but no file with that name was attached`,
          );
        }
        return { ...s, image_url: resolved };
      }
      return s;
    });
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // Find the ad account that owns the chosen ad set.
  const [acct] = await db
    .select({ adAccountId: schema.campaigns.adAccountId })
    .from(schema.adSets)
    .innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.adSets.campaignId))
    .where(
      and(
        eq(schema.adSets.orgId, session.orgId),
        eq(schema.adSets.id, adSetId),
      ),
    )
    .limit(1);
  if (!acct) {
    return { ok: false, message: "Ad set not in your org." };
  }

  const result = await runVariationFactory({
    orgId: session.orgId,
    adAccountId: acct.adAccountId,
    adSetId,
    pageId,
    specs,
    actor: { type: "user", userId: session.userId },
  });

  revalidatePath("/dashboard");
  revalidatePath("/journal");
  return { ok: true, ...result };
}

export type ActivateResult = {
  ok: number;
  failed: number;
  errors: { adId: string; error: string }[];
};

export async function activateDrafts(adIds: string[]): Promise<ActivateResult> {
  if (adIds.length === 0) return { ok: 0, failed: 0, errors: [] };
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { ok: 0, failed: adIds.length, errors: adIds.map((id) => ({ adId: id, error: "not signed in" })) };
  }
  // Reuse the bulk action with status=ACTIVE.
  const { bulkSetAdStatusAction } = await import("@/lib/meta/actions");
  const r = await bulkSetAdStatusAction({
    orgId: session.orgId,
    adIds,
    status: "ACTIVE",
    actor: { type: "user", userId: session.userId },
    reasoning: "Activated from variation factory results grid",
  });
  revalidatePath("/dashboard");
  revalidatePath("/journal");
  return {
    ok: r.ok,
    failed: r.failed,
    errors: r.results
      .filter((x) => !x.ok)
      .map((x) => ({ adId: x.metaAdId, error: x.message ?? "failed" })),
  };
}

// ─── Bulk mode: N creatives → N ad sets (factory-run Inngest job) ──────────

/**
 * Mint signed browser→Supabase upload URLs for the bulk dropzone. Files go
 * straight to storage from the client (the 30-image + 20-video batches this
 * exists for would blow the server-action body limit as FormData).
 */
export async function prepareFactoryUploadsAction(
  files: Array<{ name: string; type: string; size: number }>,
): Promise<{ ok: true; uploads: SignedAssetUpload[] } | { ok: false; message: string }> {
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { ok: false, message: "Not signed in." };
  }
  if (files.length === 0) return { ok: false, message: "No files." };
  if (files.length > 60) return { ok: false, message: "Max 60 files per run." };
  try {
    await ensurePostAssetsBucket();
    const uploads = await createSignedAssetUploads({
      orgId: session.orgId,
      userId: session.userId,
      files,
    });
    return { ok: true, uploads };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

const CopyVariationSchema = z.object({
  primaryText: z.string().min(1).max(2200),
  headline: z.string().max(120).optional(),
  description: z.string().max(300).optional(),
});

const QueueInputSchema = z.object({
  templateAdSetId: z.string().uuid(),
  campaignId: z.string().uuid().optional(), // defaults to the template's campaign
  pageId: z.string().uuid(),
  batchSlug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9-]+$/, "batch slug must be lowercase letters/digits/hyphens only"),
  linkUrl: z.string().url().optional(),
  callToAction: z.enum(CTA_VALUES).optional(),
  copySet: z.array(CopyVariationSchema).min(1).max(4),
  assets: z
    .array(
      z.object({
        fileName: z.string().min(1),
        publicUrl: z.string().url(),
        kind: z.enum(["image", "video"]),
      }),
    )
    .min(1)
    .max(60),
});

export type QueueFactoryRunInput = z.infer<typeof QueueInputSchema>;

/**
 * Queue a durable bulk-launch: one new PAUSED ad set (copied from the template)
 * + one PAUSED draft ad per uploaded creative. Inserts a `factory_runs` row so
 * the UI has a runId to poll immediately, then fires the `factory/run.requested`
 * Inngest event that does the multi-minute work server-side.
 */
export async function queueFactoryRunAction(
  input: QueueFactoryRunInput,
): Promise<{ ok: boolean; runId?: string; message?: string }> {
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { ok: false, message: "Not signed in." };
  }
  const parsed = QueueInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, message: `${issue.path.join(".") || "input"}: ${issue.message}` };
  }
  const data = parsed.data;
  const orgId = session.orgId;

  // Resolve the template ad set → its campaign + ad account.
  const [template] = await db
    .select({
      campaignId: schema.adSets.campaignId,
      adAccountId: schema.campaigns.adAccountId,
      metaAccountId: schema.adAccounts.metaAccountId,
    })
    .from(schema.adSets)
    .innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.adSets.campaignId))
    .innerJoin(schema.adAccounts, eq(schema.adAccounts.id, schema.campaigns.adAccountId))
    .where(and(eq(schema.adSets.orgId, orgId), eq(schema.adSets.id, data.templateAdSetId)))
    .limit(1);
  if (!template) return { ok: false, message: "Template ad set not in your org." };

  const destCampaignId = data.campaignId ?? template.campaignId;
  if (destCampaignId !== template.campaignId) {
    // Destination must live in the same ad account — Meta /copies retargets
    // campaigns within an account, not across accounts.
    const [dest] = await db
      .select({ adAccountId: schema.campaigns.adAccountId })
      .from(schema.campaigns)
      .where(and(eq(schema.campaigns.orgId, orgId), eq(schema.campaigns.id, destCampaignId)))
      .limit(1);
    if (!dest) return { ok: false, message: "Destination campaign not in your org." };
    if (dest.adAccountId !== template.adAccountId) {
      return {
        ok: false,
        message: "Destination campaign must be in the same ad account as the template ad set.",
      };
    }
  }

  const [pageRow] = await db
    .select({ id: schema.pages.id })
    .from(schema.pages)
    .where(and(eq(schema.pages.orgId, orgId), eq(schema.pages.id, data.pageId)))
    .limit(1);
  if (!pageRow) return { ok: false, message: "Page not in your org." };

  // Precompute every item deterministically: images first then videos (stable
  // upload order), copy variation = index % K round-robin, names carry the
  // batch slug so re-runs skip-by-name instead of duplicating.
  const ordered = [
    ...data.assets.filter((a) => a.kind === "image"),
    ...data.assets.filter((a) => a.kind === "video"),
  ];
  const items: FactoryRunItem[] = ordered.map((a, i) => ({
    index: i,
    kind: a.kind,
    fileName: a.fileName,
    assetUrl: a.publicUrl,
    copyIndex: i % data.copySet.length,
    adSetName: `${data.batchSlug}-${i + 1}`,
    adName: `variation-${data.batchSlug}-${i + 1}`,
    status: "pending",
  }));

  const [run] = await db
    .insert(schema.factoryRuns)
    .values({
      orgId,
      adAccountId: template.adAccountId,
      campaignId: destCampaignId,
      templateAdSetId: data.templateAdSetId,
      pageId: data.pageId,
      batchSlug: data.batchSlug,
      linkUrl: data.linkUrl ?? null,
      callToAction: data.callToAction ?? null,
      status: "queued",
      total: items.length,
      items: items as unknown,
      copySet: data.copySet as unknown,
      triggeredBy: session.userId,
    })
    .returning({ id: schema.factoryRuns.id });

  try {
    await inngest.send({
      name: "factory/run.requested",
      data: {
        orgId,
        runId: run.id,
        adAccountMetaId: template.metaAccountId,
        triggeredBy: session.userId,
      },
    });
  } catch (err) {
    await db
      .update(schema.factoryRuns)
      .set({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        updatedAt: sql`now()`,
      })
      .where(eq(schema.factoryRuns.id, run.id));
    return {
      ok: false,
      runId: run.id,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  revalidatePath("/campaigns/factory/runs");
  return { ok: true, runId: run.id };
}

/**
 * Activate reviewed drafts from a bulk run: the ad set AND the single ad
 * inside it (both were created PAUSED). Reuses the journaled bulk status
 * actions so every activation lands in the decision journal.
 */
export async function activateFactoryItems(
  picks: Array<{ draftAdId: string; localAdSetId?: string }>,
): Promise<ActivateResult> {
  if (picks.length === 0) return { ok: 0, failed: 0, errors: [] };
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return {
      ok: 0,
      failed: picks.length,
      errors: picks.map((p) => ({ adId: p.draftAdId, error: "not signed in" })),
    };
  }
  const { bulkSetAdStatusAction, bulkSetAdSetStatusAction } = await import("@/lib/meta/actions");
  const adSetIds = Array.from(
    new Set(picks.map((p) => p.localAdSetId).filter((x): x is string => Boolean(x))),
  );
  if (adSetIds.length > 0) {
    await bulkSetAdSetStatusAction({
      orgId: session.orgId,
      adSetIds,
      status: "ACTIVE",
      actor: { type: "user", userId: session.userId },
      reasoning: "Activated from factory bulk-run results",
    });
  }
  const r = await bulkSetAdStatusAction({
    orgId: session.orgId,
    adIds: picks.map((p) => p.draftAdId),
    status: "ACTIVE",
    actor: { type: "user", userId: session.userId },
    reasoning: "Activated from factory bulk-run results",
  });
  revalidatePath("/dashboard");
  revalidatePath("/journal");
  return {
    ok: r.ok,
    failed: r.failed,
    errors: r.results
      .filter((x) => !x.ok)
      .map((x) => ({ adId: x.metaAdId, error: x.message ?? "failed" })),
  };
}
