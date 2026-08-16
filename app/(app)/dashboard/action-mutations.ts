"use server";

import { revalidatePath } from "next/cache";
import { requireAppSession } from "@/lib/auth/session";
import {
  bulkSetAdStatusAction,
  setAdStatusAction,
  type AdActionResult,
} from "@/lib/meta/actions";

export type SingleAdResult = { ok: boolean; message?: string };

export async function setSingleAdStatus(
  adId: string,
  status: "ACTIVE" | "PAUSED",
): Promise<SingleAdResult> {
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { ok: false, message: "Not signed in" };
  }
  const r = await setAdStatusAction({
    orgId: session.orgId,
    adId,
    status,
    actor: { type: "user", userId: session.userId },
  });
  revalidatePath("/dashboard");
  revalidatePath("/journal");
  return { ok: r.ok, message: r.message };
}

export type BulkResult = {
  ok: number;
  failed: number;
  results: AdActionResult[];
};

export async function bulkSetAdStatus(
  adIds: string[],
  status: "ACTIVE" | "PAUSED",
  reasoning?: string,
): Promise<BulkResult | { ok: 0; failed: 0; results: []; error: string }> {
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { ok: 0, failed: 0, results: [], error: "Not signed in" };
  }
  const r = await bulkSetAdStatusAction({
    orgId: session.orgId,
    adIds,
    status,
    actor: { type: "user", userId: session.userId },
    reasoning,
  });
  revalidatePath("/dashboard");
  revalidatePath("/journal");
  return r;
}
