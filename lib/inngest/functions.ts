import { inngest } from "./client";
import { insightsSyncDaily, insightsSyncOnDemand } from "./insights-sync";
import { cloneCampaignToAccount } from "./clone-campaign-to-account";
import { factoryRun } from "./factory-run";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * DELIBERATELY NOT REGISTERED HERE: the rule runners.
 * ─────────────────────────────────────────────────────────────────────────
 * The parent app (ai-ads-agent) already runs `rules-runner-frequent`
 * (every 5 min), `rules-runner-daily-kl` (00:00 KL) and
 * `rules-daily-preview-kl` against BOTH ad accounts this app manages —
 * they live inside its project "AI 网络自由创业".
 *
 * If this app registered its own rule runners, two schedulers would evaluate
 * and pause the same real Meta ads. That is exactly the failure that produced
 * a blank row and an overwritten day on 2026-07-04. So /rules here is
 * manage + dry-run only; enforcement stays in the parent app.
 *
 * Do not add ruleRunnerFrequent / ruleRunnerDaily / ruleDailyPreview to the
 * list below without moving enforcement off the parent app first.
 *
 * Insights sync IS duplicated, and that is safe — it only reads from Meta.
 */

/**
 * Smoke-test job. Trigger by sending an event named "test/hello":
 *   await inngest.send({ name: "test/hello", data: { name: "Andi" } });
 */
export const helloWorld = inngest.createFunction(
  {
    id: "hello-world",
    triggers: [{ event: "test/hello" }],
  },
  async ({ event, step }) => {
    await step.sleep("brief-pause", "1s");
    const data = event.data as { name?: string } | undefined;
    return { greeting: `Hello, ${data?.name ?? "world"}!` };
  },
);

export const functions = [
  helloWorld,
  // Dashboard + Campaigns freshness. 0 17 * * * UTC = 01:00 KL.
  insightsSyncDaily,
  // Fired by the "Refresh from Meta" button on /campaigns.
  insightsSyncOnDemand,
  // Cross-account campaign clone (/campaigns/clone-jobs).
  cloneCampaignToAccount,
  // Bulk launch (/campaigns/factory).
  factoryRun,
];
