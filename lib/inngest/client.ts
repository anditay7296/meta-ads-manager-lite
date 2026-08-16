import { Inngest } from "inngest";
import { ObservabilityMiddleware } from "./observability-middleware";

export const inngest = new Inngest({
  // MUST NOT be "ai-ads-agent" — that is the parent app's id. Inngest keys an
  // app by (environment, id), so sharing the id means whichever deployment
  // syncs last owns the record and the other's functions are archived. If Lite
  // won that race the parent would silently stop running its rule runners, and
  // because the event names match too (factory/run.requested,
  // campaign/clone-to-account, insights/sync.all), jobs triggered here could
  // execute inside the parent against the parent's database.
  //
  // Use a separate Inngest ENVIRONMENT as well — a distinct id alone does not
  // stop cross-app event routing when the event key is shared.
  id: "meta-ads-manager-lite",
  // INNGEST_EVENT_KEY + INNGEST_SIGNING_KEY are read from env automatically.
  // Single middleware covering heartbeats (registration-drop detection) +
  // usage counting (free-tier quota watch) — see observability-middleware.ts
  // for why these are one class instead of two: registering 2+ middleware
  // classes breaks step.run's type inference project-wide.
  middleware: [ObservabilityMiddleware],
});
