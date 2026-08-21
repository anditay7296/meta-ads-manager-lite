import { inngest } from "./client";
import { db, schema } from "@/lib/db/client";
import { and, eq, sql } from "drizzle-orm";
import { getMetaClientForMetaAccountId } from "@/lib/meta/get-client";
import { cloneAdSetToCampaign } from "@/lib/meta/actions";
import { journalAppend } from "@/lib/db/queries/journal";

const { cloneJobs, campaigns } = schema;

/**
 * Durable cross-account campaign clone. Backs the in-app "Clone campaign →
 * another account" button (app/(app)/campaigns/CloneCampaignDialog.tsx →
 * cloneCampaignToAccountAction). Clones every LIVE (ACTIVE+PAUSED) ad set of a
 * source campaign into a same-named destination campaign in another ad account.
 *
 * Design notes:
 *  - One `step.run` per ad set → each is a Vercel-timeout-proof checkpoint, so
 *    a multi-hour job spans many short invocations and resumes where it left off.
 *  - Each clone step does a bounded in-step retry (Meta/DB blips self-heal) and
 *    RE-CHECKS the destination by full ad-set NAME before every attempt, which
 *    makes it duplicate-safe: cloneAdSetToCampaign's native /copies is NOT
 *    idempotent (new ad set per call), so a retry after a partial create just
 *    sees the name and skips. Name — not code — because GT1 ad-set codes collide
 *    cross-account (see extractAdCode / auto-sync-aia matchBy:"name").
 *  - Progress is written to the clone_jobs row after every ad set so the
 *    /campaigns/clone-jobs page can poll it (the app has no websockets).
 *  - A circuit breaker (MAX_FAILURES) aborts the job once more than ten ad
 *    sets have failed — see the constant for why.
 *  - The destination campaign must already exist by the time the event fires;
 *    this job never creates campaigns (cloneCampaignToAccountAction auto-creates
 *    a same-named PAUSED campaign first when the operator picks an account
 *    without one).
 */

export type CloneCampaignEventData = {
  orgId: string;
  sourceMetaAccountId: string;
  sourceCampaignId: string; // local UUID
  destMetaAccountId: string;
  destCampaignId: string; // local UUID
  jobId: string;
  triggeredBy: string; // userId
};

type PerAdSetEntry = {
  name: string;
  status: "cloned" | "skipped" | "failed";
  newAdSetMetaId?: string;
  needsManualIgFix?: number;
  /** Ads actually rebuilt inside the new ad set. An ad set can be created
   * successfully and still end up empty — see the status logic below. */
  adsCreated?: number;
  adsFailed?: number;
  error?: string;
};

const CLONE_ATTEMPTS = 3; // bounded in-step self-heal for transient blips
const PACE = "5s"; // checkpointed gap between ad sets (Meta cross-account throttle)
/**
 * Circuit breaker. Once MORE than this many ad sets have failed, the job stops
 * instead of grinding through the rest. Past this point the failures are
 * almost never per-ad-set — they are one systemic cause (archived destination
 * campaign, Page not shareable into the dest Business, expired token…) that
 * every remaining ad set will hit identically, and each attempt still costs
 * Meta rate-limit budget plus 5s of pacing. The job ends as `failed` with an
 * explanatory `error`; a re-run after fixing the cause skips by name, so
 * nothing already cloned is redone.
 */
const MAX_FAILURES = 10;

export const cloneCampaignToAccount = inngest.createFunction(
  {
    id: "clone-campaign-to-account",
    name: "Clone campaign ad sets cross-account",
    triggers: [{ event: "campaign/clone-to-account" }],
    // One concurrent run per destination account — Meta throttles per ad
    // account, and serializing keeps two runs (or a double-click) from racing
    // duplicates into the same dest before the skip-by-name re-check can see them.
    concurrency: { key: "event.data.destMetaAccountId", limit: 1 },
    // Belt-and-suspenders for the non-clone infra steps (enumerate / record /
    // finalize) — the clone step itself never throws (it records failures).
    retries: 3,
  },
  async ({ event, step }) => {
    const data = event.data as CloneCampaignEventData;
    const {
      orgId,
      sourceMetaAccountId,
      sourceCampaignId,
      destMetaAccountId,
      destCampaignId,
      jobId,
      triggeredBy,
    } = data;

    // A) Resolve meta campaign ids + enumerate source ad sets. listAdSetsForCampaign
    //    returns Meta's default (ACTIVE + PAUSED) — archived excluded, which is
    //    exactly "live only".
    const src = await step.run("enumerate-source", async () => {
      const [srcCamp] = await db
        .select({ metaCampaignId: campaigns.metaCampaignId })
        .from(campaigns)
        .where(and(eq(campaigns.orgId, orgId), eq(campaigns.id, sourceCampaignId)))
        .limit(1);
      const [dstCamp] = await db
        .select({ metaCampaignId: campaigns.metaCampaignId })
        .from(campaigns)
        .where(and(eq(campaigns.orgId, orgId), eq(campaigns.id, destCampaignId)))
        .limit(1);
      if (!srcCamp || !dstCamp) throw new Error("Source or destination campaign not found");
      const meta = await getMetaClientForMetaAccountId(orgId, sourceMetaAccountId);
      if (!meta) throw new Error("No Meta connection for source account");
      const list = await meta.client.listAdSetsForCampaign(srcCamp.metaCampaignId);
      return {
        dstMetaCampaignId: dstCamp.metaCampaignId,
        adSets: list.data.map((d) => ({ metaId: d.id, name: d.name })),
      };
    });

    await step.run("init-total", async () => {
      await db
        .update(cloneJobs)
        .set({ total: src.adSets.length, status: "running", updatedAt: sql`now()` })
        .where(eq(cloneJobs.id, jobId));
    });

    // B) One checkpoint per ad set.
    let aborted = false;
    let attempted = 0;
    for (const a of src.adSets) {
      attempted++;
      const outcome = await step.run(`clone-${a.metaId}`, async (): Promise<PerAdSetEntry> => {
        let lastErr = "";
        for (let attempt = 1; attempt <= CLONE_ATTEMPTS; attempt++) {
          try {
            const dstMeta = await getMetaClientForMetaAccountId(orgId, destMetaAccountId);
            if (!dstMeta) throw new Error("No Meta connection for destination account");
            // Skip-by-NAME re-check (dup-safe across attempts / re-runs).
            const destList = await dstMeta.client.listAdSetsForCampaign(src.dstMetaCampaignId);
            if (destList.data.some((d) => d.name === a.name)) {
              return { name: a.name, status: "skipped" };
            }
            const r = await cloneAdSetToCampaign({
              orgId,
              sourceAdSetMetaId: a.metaId,
              destCampaignId,
              actor: { type: "user", userId: triggeredBy },
            });
            if (r.ok) {
              // `r.ok` only means the AD SET was created. Its ads are rebuilt
              // in a separate pass that can fail on its own — most commonly
              // when the destination account sits in another Business
              // portfolio and cannot promote the source Page, so every
              // creative is rejected. Reporting "cloned" on `r.ok` alone hid
              // exactly that: a campaign of empty ad sets under a "48/48
              // cloned, 0 failed" job. An ad set is only cleanly cloned when
              // nothing complained; a source ad set with no ads at all still
              // counts as clean (created 0, failed 0, no errors).
              const ads = r.ads;
              const adsBroke = ads.failed > 0 || ads.errors.length > 0;
              return {
                name: a.name,
                status: adsBroke ? "failed" : "cloned",
                newAdSetMetaId: r.newAdSetMetaId,
                needsManualIgFix: ads.needsManualIgFix ?? 0,
                adsCreated: ads.created,
                adsFailed: ads.failed,
                ...(adsBroke
                  ? {
                      error:
                        `ad set created but ${ads.failed} ad(s) failed to clone — ` +
                        (ads.errors[0] ?? "no error reported"),
                    }
                  : {}),
              };
            }
            // Definitive failure — cloneAdSetToCampaign already exhausted its
            // internal /copies + ROAS fallback, so retrying won't help. Record
            // and move on (one bad ad set must not fail the whole job).
            return { name: a.name, status: "failed", error: r.message };
          } catch (err) {
            // Transient (Supabase drop / Meta 5xx / 429). The loop top re-checks
            // dest by name, so retrying is duplicate-safe.
            lastErr = err instanceof Error ? err.message : String(err);
            if (attempt < CLONE_ATTEMPTS) await new Promise((res) => setTimeout(res, 3000));
          }
        }
        return { name: a.name, status: "failed", error: lastErr };
      });

      // Record progress. Idempotent: skip if this ad set's name is already
      // logged (guards the rare retry-after-commit double count). Returns the
      // job's running failure count so the loop can trip the circuit breaker.
      const failedSoFar = await step.run(`record-${a.metaId}`, async (): Promise<number> => {
        const [job] = await db
          .select({ perAdSet: cloneJobs.perAdSet, failed: cloneJobs.failed })
          .from(cloneJobs)
          .where(eq(cloneJobs.id, jobId))
          .limit(1);
        const existing = (job?.perAdSet as PerAdSetEntry[] | null) ?? [];
        if (existing.some((e) => e.name === outcome.name)) return job?.failed ?? 0;
        const [updated] = await db
          .update(cloneJobs)
          .set({
            cloned: outcome.status === "cloned" ? sql`${cloneJobs.cloned} + 1` : sql`${cloneJobs.cloned}`,
            skipped: outcome.status === "skipped" ? sql`${cloneJobs.skipped} + 1` : sql`${cloneJobs.skipped}`,
            failed: outcome.status === "failed" ? sql`${cloneJobs.failed} + 1` : sql`${cloneJobs.failed}`,
            perAdSet: sql`${cloneJobs.perAdSet} || ${JSON.stringify(outcome)}::jsonb`,
            updatedAt: sql`now()`,
          })
          .where(eq(cloneJobs.id, jobId))
          .returning({ failed: cloneJobs.failed });
        return updated?.failed ?? 0;
      });

      if (failedSoFar > MAX_FAILURES) {
        aborted = true;
        break;
      }

      // Checkpointed pacing — no Vercel CPU billed during the wait.
      await step.sleep(`pace-${a.metaId}`, PACE);
    }

    // C) Finalize + journal.
    const notAttempted = src.adSets.length - attempted;
    return step.run("finalize", async () => {
      const [job] = await db.select().from(cloneJobs).where(eq(cloneJobs.id, jobId)).limit(1);
      const failed = job?.failed ?? 0;
      const status: "done" | "done_with_errors" | "failed" = aborted
        ? "failed"
        : failed > 0
          ? "done_with_errors"
          : "done";
      const error = aborted
        ? `Stopped automatically after ${failed} ad sets failed (limit ${MAX_FAILURES}) — ` +
          `${notAttempted} ad set(s) were not attempted. Fix the cause shown below, then ` +
          `re-run the clone; it skips everything already cloned.`
        : null;
      await db
        .update(cloneJobs)
        .set({ status, error, updatedAt: sql`now()` })
        .where(eq(cloneJobs.id, jobId));
      await journalAppend({
        orgId,
        actorType: "user",
        actorRef: triggeredBy,
        summary:
          (aborted ? "Clone stopped early: " : "Cloned ") +
          `campaign "${job?.sourceCampaignName ?? "?"}" → ${job?.destAccountName ?? "?"}: ${job?.cloned ?? 0} cloned, ${job?.skipped ?? 0} skipped, ${failed} failed` +
          (aborted ? `, ${notAttempted} not attempted` : ""),
        entityKind: "campaign",
        entityId: destCampaignId,
        after: { cloned: job?.cloned, skipped: job?.skipped, failed, status, aborted, notAttempted },
        metadata: { action: "clone_campaign_to_account", jobId, destMetaAccountId },
      });
      return { jobId, cloned: job?.cloned ?? 0, skipped: job?.skipped ?? 0, failed, status, aborted };
    });
  },
);
