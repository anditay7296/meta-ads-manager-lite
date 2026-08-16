import Link from "next/link";
import { Topbar } from "@/components/app-shell/Topbar";
import { getAppSession } from "@/lib/auth/session";
import { resolveActiveProject } from "@/lib/auth/active-project";
import { db, schema } from "@/lib/db/client";
import { and, eq, inArray } from "drizzle-orm";
import { listCopyEntries, getCopyEntry } from "@/lib/db/queries/copy";
import { ManagerTabs } from "../ManagerTabs";
import { FactoryForm } from "./FactoryForm";

export default async function FactoryPage({
  searchParams,
}: {
  searchParams: Promise<{ adset?: string }>;
}) {
  const session = await getAppSession();
  if (!session) return null;
  const active = await resolveActiveProject({
    orgId: session.orgId,
    userId: session.userId,
  });
  if (!active) return null;

  const accounts = await db
    .select({ id: schema.adAccounts.id, name: schema.adAccounts.name })
    .from(schema.adAccounts)
    .where(
      and(
        eq(schema.adAccounts.orgId, session.orgId),
        eq(schema.adAccounts.projectId, active.id),
      ),
    );
  const accountIds = accounts.map((a) => a.id);
  const accountNameById = new Map(accounts.map((a) => [a.id, a.name]));

  const campaigns =
    accountIds.length === 0
      ? []
      : await db
          .select({
            id: schema.campaigns.id,
            name: schema.campaigns.name,
            adAccountId: schema.campaigns.adAccountId,
          })
          .from(schema.campaigns)
          .where(
            and(
              eq(schema.campaigns.orgId, session.orgId),
              inArray(schema.campaigns.adAccountId, accountIds),
            ),
          );
  const campaignIdToName = new Map(campaigns.map((c) => [c.id, c.name]));
  const campaignIdToAcct = new Map(campaigns.map((c) => [c.id, c.adAccountId]));

  const adSets =
    campaigns.length === 0
      ? []
      : await db
          .select({
            id: schema.adSets.id,
            name: schema.adSets.name,
            campaignId: schema.adSets.campaignId,
          })
          .from(schema.adSets)
          .where(
            and(
              eq(schema.adSets.orgId, session.orgId),
              inArray(
                schema.adSets.campaignId,
                campaigns.map((c) => c.id),
              ),
            ),
          );

  const adSetOptions = adSets.map((s) => {
    const camp = campaignIdToName.get(s.campaignId) ?? "—";
    const acct =
      accountNameById.get(campaignIdToAcct.get(s.campaignId) ?? "") ?? "—";
    return {
      id: s.id,
      label: `${acct} · ${camp} · ${s.name}`,
      campaignId: s.campaignId,
    };
  });

  const campaignOptions = campaigns.map((c) => ({
    id: c.id,
    label: `${accountNameById.get(c.adAccountId) ?? "—"} · ${c.name}`,
  }));

  const pages = await db
    .select({ id: schema.pages.id, name: schema.pages.name })
    .from(schema.pages)
    .where(
      and(
        eq(schema.pages.orgId, session.orgId),
        eq(schema.pages.projectId, active.id),
      ),
    );
  const pageOptions = pages.map((p) => ({ id: p.id, label: p.name }));

  // Pull copy entries + variants so the form can offer "Import from copy library".
  const copyEntriesList = await listCopyEntries({ orgId: session.orgId });
  const copyEntriesWithVariants = await Promise.all(
    copyEntriesList.slice(0, 30).map(async (entry) => {
      const detail = await getCopyEntry({
        orgId: session.orgId,
        entryId: entry.id,
      });
      return {
        id: entry.id,
        title: entry.title,
        painPointSlug: entry.painPointSlug,
        funnelStage: entry.funnelStage,
        variants:
          detail?.variants.map((v) => ({
            variantNumber: v.variantNumber,
            primaryText: v.primaryText,
            headline: v.headline,
            description: v.description,
            callToAction: v.callToAction,
          })) ?? [],
      };
    }),
  );

  const { adset } = await searchParams;

  return (
    <>
      <Topbar
        title="Bulk variation factory"
        subtitle={`${active.name} · bulk-launch paused ad sets + ads from your creatives`}
      />
      <ManagerTabs active="factory" />
      <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-8">
        <details className="rounded-md border border-blue-100 bg-blue-50 px-4 py-3 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200">
          <summary className="cursor-pointer font-medium">
            How it works — Bulk launch vs Advanced JSON
          </summary>
          <p className="mt-2">
            <strong>Bulk launch (default):</strong> drop N images/videos, pick a
            template ad set + 1–4 copy variations. Each file becomes its OWN new
            PAUSED ad set (settings copied from the template) containing exactly
            one PAUSED ad. Runs in the background — watch progress on the run
            page, then activate the ones you want.
          </p>
          <p className="mt-2">
            <strong>Advanced JSON:</strong> the original spec format below — all
            ads land in ONE existing ad set, synchronous, images only.
          </p>
          <div className="mt-2">
          <p className="font-medium">JSON spec format — two paths per entry:</p>
          <p className="mt-2">
            <strong>Path A: boost an existing post</strong>
          </p>
          <pre className="mt-1 overflow-x-auto text-[10px] leading-snug">
{`{
  "pain_point_slug": "low-confidence",
  "variation_number": 1,
  "post_id": "<page_id>_<post_id>"
}`}
          </pre>
          <p className="mt-3">
            <strong>Path B: build a fresh creative from an image URL + copy</strong>
          </p>
          <pre className="mt-1 overflow-x-auto text-[10px] leading-snug">
{`{
  "pain_point_slug": "low-confidence",
  "variation_number": 1,
  "image_url": "https://your-cdn.com/creative.jpg",
  "primary_text": "Your hook text goes here",
  "headline": "Compelling headline",
  "description": "Optional",
  "link_url": "https://yourfunnel.com",
  "call_to_action": "LEARN_MORE"
}`}
          </pre>
          <p className="mt-3">
            CTA values: LEARN_MORE · SHOP_NOW · SIGN_UP · GET_OFFER · DOWNLOAD ·
            CONTACT_US · SUBSCRIBE · MESSAGE_PAGE · WHATSAPP_MESSAGE.
          </p>
          <p className="mt-2">
            Each entry → 1 paused ad named{" "}
            <code className="rounded bg-blue-100 px-1 py-0.5 text-[10px] dark:bg-blue-900">
              variation-&#123;pain_point_slug&#125;-&#123;variation_number&#125;
            </code>
            . For Path B, the image is uploaded to the ad account once per entry,
            so 100 entries = 100 image uploads + 100 creatives + 100 ads. Plan
            for ~200ms per call against Meta's rate limits.
          </p>
          <p className="mt-2">
            <Link
              href="/campaigns"
              className="underline-offset-2 hover:underline"
            >
              ← Back to Campaigns list
            </Link>
          </p>
          </div>
        </details>

        <FactoryForm
          adSets={adSetOptions}
          campaigns={campaignOptions}
          pages={pageOptions}
          defaultAdSetId={adset}
          copyEntries={copyEntriesWithVariants}
        />
      </div>
    </>
  );
}
