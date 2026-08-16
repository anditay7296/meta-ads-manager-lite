"use server";

import { revalidatePath } from "next/cache";
import { requireAppSession } from "@/lib/auth/session";
import { resolveActiveProject } from "@/lib/auth/active-project";
import { syncProject } from "@/lib/meta/sync";
import type { DashboardRange } from "@/lib/db/queries/dashboard";

export type SyncState = { ok: boolean; message: string };

export async function refreshDashboard(
  _prev: SyncState | null,
  formData: FormData,
): Promise<SyncState> {
  const range = (String(formData.get("range") ?? "yesterday") as DashboardRange);
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { ok: false, message: "Not signed in." };
  }
  const active = await resolveActiveProject({
    orgId: session.orgId,
    userId: session.userId,
  });
  if (!active) {
    return { ok: false, message: "No active project — run scripts/bootstrap-lite.ts." };
  }
  const datePreset =
    range === "today" || range === "yesterday" || range === "last_30d"
      ? range
      : "last_7d";
  try {
    // syncProject picks the right MetaClient per ad account from its
    // owning connection — no need to resolve an org-wide client here.
    const result = await syncProject({
      orgId: session.orgId,
      projectId: active.id,
      datePreset,
    });
    revalidatePath("/dashboard");
    return {
      ok: true,
      message: `Synced: ${result.campaigns} campaigns, ${result.adSets} ad sets, ${result.ads} ads, ${result.insightsRows} insight rows.`,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
