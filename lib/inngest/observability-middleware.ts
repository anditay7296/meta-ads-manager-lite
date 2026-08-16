import { Middleware } from "inngest";
import { db, schema } from "@/lib/db/client";
import { sql } from "drizzle-orm";

/**
 * Single Inngest middleware covering both ops-observability concerns for
 * this app. Combined into one class deliberately: registering more than one
 * `Middleware.BaseMiddleware` in the client's `middleware: []` array breaks
 * Inngest v4's step-output type inference project-wide (every `step.run`
 * return type collapses to `JsonifyObject<{}>` — confirmed empirically,
 * reproducible by adding a second class to the array). One class, several
 * hooks, is the workaround.
 *
 * 1. Heartbeat (onRunStart): upserts a `cron_heartbeats` row at the start of
 *    every function run. Why: twice now (2026-05-28 ad-count guards,
 *    2026-06-28 午检+晚检) functions have silently dropped out of Inngest
 *    Cloud's registration after a bad app sync — the code is fine, the cron
 *    just never fires, and nothing anywhere records the silence. These
 *    heartbeats give the registration watchdog
 *    (`lib/inngest/registration-watchdog.ts`, driven by a Vercel cron that
 *    lives OUTSIDE Inngest) ground truth about which functions actually ran
 *    recently.
 *
 * 2. Usage counter (onStepStart/onRunComplete/onRunError): self-tracked
 *    approximation of Inngest's own "executions" meter (1 per function run +
 *    1 per step.run), since Inngest exposes no usage/billing API. Lets the
 *    same watchdog warn before the free tier's 50,000/month cap silently
 *    pauses every function — a strictly worse outage than a registration
 *    drop, since it can't be fixed by resyncing. Gated on
 *    `!stepInfo.memoized` because Inngest replays every already-completed
 *    step on each subsequent invocation of the same run; only a fresh
 *    attempt is a real new execution. `onRunComplete`/`onRunError` (not
 *    `onRunStart`) count the "base run" portion — only the terminal hooks
 *    are documented as single-fire per run, so using onRunStart here would
 *    double-count on every replay of a multi-step function.
 *
 * Must never affect the run itself: every hook is wrapped and swallowed.
 */

const APP_PREFIX = "ai-ads-agent-";

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function bumpExecutionCount(): Promise<void> {
  try {
    const month = currentMonthKey();
    await db.execute(sql`
      INSERT INTO inngest_usage_monthly (month, execution_count)
      VALUES (${month}, 1)
      ON CONFLICT (month)
      DO UPDATE SET execution_count = inngest_usage_monthly.execution_count + 1
    `);
  } catch {
    // Usage tracking must never affect the actual run.
  }
}

export class ObservabilityMiddleware extends Middleware.BaseMiddleware {
  readonly id = "observability";

  async onRunStart({ fn }: Middleware.OnRunStartArgs): Promise<void> {
    try {
      const raw = fn.id();
      const functionId = raw.startsWith(APP_PREFIX)
        ? raw.slice(APP_PREFIX.length)
        : raw;
      const now = new Date();
      await db
        .insert(schema.cronHeartbeats)
        .values({ functionId, lastRunAt: now })
        .onConflictDoUpdate({
          target: schema.cronHeartbeats.functionId,
          set: { lastRunAt: now },
        });
    } catch {
      // Heartbeat failure must never fail (or even slow) the actual run.
    }
  }

  async onStepStart({ stepInfo }: Middleware.OnStepStartArgs): Promise<void> {
    if (stepInfo.memoized) return;
    await bumpExecutionCount();
  }

  async onRunComplete(): Promise<void> {
    await bumpExecutionCount();
  }

  async onRunError({ isFinalAttempt }: Middleware.OnRunErrorArgs): Promise<void> {
    if (!isFinalAttempt) return;
    await bumpExecutionCount();
  }
}
