import { Inngest } from "inngest";
import { ObservabilityMiddleware } from "./observability-middleware";

export const inngest = new Inngest({
  id: "ai-ads-agent",
  // INNGEST_EVENT_KEY + INNGEST_SIGNING_KEY are read from env automatically.
  // Single middleware covering heartbeats (registration-drop detection) +
  // usage counting (free-tier quota watch) — see observability-middleware.ts
  // for why these are one class instead of two: registering 2+ middleware
  // classes breaks step.run's type inference project-wide.
  middleware: [ObservabilityMiddleware],
});
