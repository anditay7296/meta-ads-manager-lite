import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { functions } from "@/lib/inngest/functions";

// Override Vercel's default serverless function timeout. The default (60s on
// Pro) was killing the on-demand insights sync mid-syncProject: AIA Ads Acc
// has ~13k ads and ~6.6k ad sets, so listAds + listAdSets alone take ~65s,
// which made the function crash before reaching the next account in the loop.
// 300s (Vercel Pro max) gives a multi-account project enough headroom to
// finish a sequential sync. Per-account step.run isolation is the real fix,
// but this unblocks the immediate symptom.
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
});
