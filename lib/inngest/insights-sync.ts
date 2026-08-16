import { inngest } from "./client";
import { db, schema } from "@/lib/db/client";
import { and, eq, isNull } from "drizzle-orm";
import { syncOneAccountById, type SyncResult } from "@/lib/meta/sync";
import { checkAndUpdateAccountStatus } from "@/lib/meta/actions";

/**
 * Daily insights sync. Fires at 01:00 Asia/Kuala_Lumpur (= 17:00 UTC the
 * previous day, cron `0 17 * * *`). Iterates every ad account under every
 * active project + syncs each one as its own `step.run` checkpoint so the
 * Vercel function timeout (300s on Pro) applies PER ACCOUNT instead of
 * per-project.
 *
 * Also reachable on-demand via the `insights/sync.all` event.
 *
 * **Why per-account `step.run` instead of per-project:** The previous shape
 * wrapped all of a project's accounts in a single `step.run`, so the
 * slowest account's wall-clock dominated the shared 300s budget. When the
 * project total exceeded the budget, Vercel killed the function partway
 * through and the tail-end accounts silently went unsynced (2026-05-31
 * AIA Newspaper incident: DB showed 10 active for 3 days while Meta UI had
 * 2). Per-account `step.run` gives each account its own 300s budget, its
 * own retry, and its own alert; one slow account no longer drags the
 * others down.
 *
 * Resilience (added after the 2026-05-08 silent-zeros incident):
 *   1. **Auto-retry once.** If the per-account sync either throws or
 *      returns insightsRows === 0 for an account that has any active ads,
 *      retry it one time with a 30s back-off. Catches transient Meta 5xx
 *      + rate-limit hiccups without needing the operator to click "Sync
 *      now".
 *   2. **Sync-failure alert.** If an account still ends up with no
 *      insights after the retry, write a named alert to the Inngest run log
 *      via console.error — Lite ships no notification channels, so the
 *      Inngest dashboard is where it surfaces. Skipped silently when the
 *      account has zero active ads (genuinely nothing to sync — not a
 *      failure).
 */
type SyncSummary = {
  orgId: string;
  projectId: string;
  projectName: string;
  adAccountId: string;
  adAccountName: string;
  ok: boolean;
  counts?: SyncResult;
  retried?: boolean;
  alerted?: boolean;
  error?: string;
};

const handler = async ({
  step,
}: {
  step: {
    run: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
    sleep: (name: string, duration: string) => Promise<void>;
  };
}) => {
  // Resolve (orgId, projectId, projectName, adAccountId, adAccountName)
  // tuples up front. One step.run per tuple — each account is its own
  // independent unit of work with its own Vercel function timeout. Skipping
  // archived projects matches the prior behaviour.
  const tuples = await db
    .select({
      orgId: schema.adAccounts.orgId,
      projectId: schema.adAccounts.projectId,
      projectName: schema.projects.name,
      adAccountId: schema.adAccounts.id,
      adAccountName: schema.adAccounts.name,
      metaAccountId: schema.adAccounts.metaAccountId,
    })
    .from(schema.adAccounts)
    .innerJoin(
      schema.projects,
      eq(schema.projects.id, schema.adAccounts.projectId),
    )
    .where(isNull(schema.projects.archivedAt));

  const summaries: SyncSummary[] = [];

  for (const t of tuples) {
    if (!t.projectId) continue; // ad account with no project assignment — skip silently
    const projectId = t.projectId;

    // First pass — wrapped in step.run so Inngest checkpoints the result.
    // syncOneAccountById is connection-aware: it picks the MetaClient from
    // the account's `connectionId`, decrypts the token, runs the sync,
    // flushes its own audit batch. Failures don't escape — caught here so
    // the per-account flow can decide retry/alert.
    const firstPass = await step.run(
      `sync-${t.orgId}-${t.adAccountId}`,
      async () => {
        try {
          const counts = await syncOneAccountById({
            orgId: t.orgId,
            adAccountId: t.adAccountId,
            datePreset: "last_7d",
          });
          // null = no usable connection (revoked / missing) — treat as a
          // legitimate skip, not a failure. The alert path below filters
          // these out via accountHasActiveAds().
          return { counts, error: null as string | null };
        } catch (err) {
          return {
            counts: null as SyncResult | null,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    );

    let counts: SyncResult | null = firstPass.counts;
    let firstError: string | null = firstPass.error;
    const looksFailed =
      firstError !== null ||
      (counts !== null && counts.insightsRows === 0);
    let retried = false;

    if (looksFailed) {
      const hasActiveAds = await step.run(
        `check-active-ads-${t.adAccountId}`,
        () =>
          accountHasActiveAds({
            orgId: t.orgId,
            adAccountId: t.adAccountId,
          }),
      );
      if (hasActiveAds) {
        retried = true;
        // step.sleep checkpoints — no Vercel CPU billed during the wait.
        await step.sleep(`retry-backoff-${t.adAccountId}`, "30s");
        const retryPass = await step.run(
          `sync-retry-${t.adAccountId}`,
          async () => {
            try {
              const c = await syncOneAccountById({
                orgId: t.orgId,
                adAccountId: t.adAccountId,
                datePreset: "last_7d",
              });
              return { counts: c, error: null as string | null };
            } catch (err) {
              return {
                counts: null as SyncResult | null,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          },
        );
        counts = retryPass.counts;
        firstError = retryPass.error;
      }
    }

    const r = await step.run(`finalize-${t.adAccountId}`, async () => {
      // Per-account alert — fires only when the account had active ads but
      // produced no insights even after retry. Prevents zero-volume
      // accounts from generating noise; surfaces real sync breakage in the
      // Inngest run log instead of leaving a silently empty dashboard.
      const stillEmpty =
        firstError !== null ||
        (counts !== null && counts.insightsRows === 0);
      let alerted = false;
      if (stillEmpty) {
        const hasActiveAds = await accountHasActiveAds({
          orgId: t.orgId,
          adAccountId: t.adAccountId,
        });
        if (hasActiveAds) {
          try {
            await alertSyncFailure({
              orgId: t.orgId,
              projectId,
              projectName: t.projectName,
              adAccountName: t.adAccountName,
              error: firstError,
              retried,
            });
            alerted = true;
          } catch (alertErr) {
            console.warn(
              `[insights-sync] alert dispatch failed for ${t.adAccountId}:`,
              alertErr instanceof Error
                ? alertErr.message
                : alertErr,
            );
          }
        }
      }

      return {
        ok: !stillEmpty,
        counts: counts ?? undefined,
        retried,
        alerted,
        error: firstError ?? undefined,
      };
    });

    summaries.push({
      orgId: t.orgId,
      projectId,
      projectName: t.projectName,
      adAccountId: t.adAccountId,
      adAccountName: t.adAccountName,
      ok: r.ok,
      counts: r.counts,
      retried: r.retried,
      alerted: r.alerted,
      error: r.error,
    });

    // Proactively reconcile the is_restricted flag with Meta's account_status.
    // Non-fatal: errors are caught so they never block the insights sync.
    // Detects both new restrictions AND reinstatements automatically.
    await step.run(`status-check-${t.adAccountId}`, async () => {
      try {
        return await checkAndUpdateAccountStatus({
          orgId: t.orgId,
          accountId: t.adAccountId,
          metaAccountId: t.metaAccountId,
        });
      } catch (err) {
        console.warn(
          `[insights-sync] account-status check failed for ${t.metaAccountId}:`,
          err instanceof Error ? err.message : err,
        );
        return null;
      }
    });
  }

  return { ranAt: new Date().toISOString(), summaries };
};

/**
 * Cheap "are we expecting data" check at the account scope. Returns true
 * if the ad account has at least one ad in ACTIVE status. We don't try to
 * be clever about effective_status here — even an ADSET_PAUSED ad produces
 * zero spend legitimately, so the alert/retry only fires when there's
 * something that SHOULD have spent in the last 7d.
 */
async function accountHasActiveAds(opts: {
  orgId: string;
  adAccountId: string;
}): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.ads.id })
    .from(schema.ads)
    .innerJoin(schema.adSets, eq(schema.adSets.id, schema.ads.adSetId))
    .innerJoin(
      schema.campaigns,
      eq(schema.campaigns.id, schema.adSets.campaignId),
    )
    .where(
      and(
        eq(schema.ads.orgId, opts.orgId),
        eq(schema.campaigns.adAccountId, opts.adAccountId),
        eq(schema.ads.status, "ACTIVE"),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Record a failed per-account insights sync.
 *
 * The parent app fans this out to Telegram / WhatsApp / email via
 * `notifyOps`. Lite ships none of those channels, so the alert goes to the
 * Inngest run log instead — visible in the Inngest dashboard next to the
 * run that produced it. The failure is still recoverable the same way:
 * hit "Refresh from Meta" on /campaigns, and check `meta_api_calls` for the
 * underlying Graph API error.
 */
async function alertSyncFailure(opts: {
  orgId: string;
  projectId: string;
  projectName: string;
  adAccountName: string;
  error: string | null;
  retried: boolean;
}): Promise<void> {
  console.error(
    `[insights-sync] no data for ${opts.projectName} · ${opts.adAccountName} ` +
      `(project ${opts.projectId}, retried=${opts.retried}) — ` +
      `dashboard will show blanks for this account. ` +
      `error: ${opts.error?.slice(0, 240) ?? "none reported"}`,
  );
}

export const insightsSyncDaily = inngest.createFunction(
  {
    id: "insights-sync-daily-kl",
    triggers: [{ cron: "0 17 * * *" }],
  },
  handler,
);

export const insightsSyncOnDemand = inngest.createFunction(
  {
    id: "insights-sync-on-demand",
    triggers: [{ event: "insights/sync.all" }],
  },
  handler,
);
