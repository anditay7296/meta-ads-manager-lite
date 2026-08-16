"use server";

import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { requireAppSession } from "@/lib/auth/session";
import { setNavOrderCookie } from "@/lib/sidebar/nav-order";
import { NAV_ITEMS } from "./nav-items";

export async function saveNavOrderAction(order: string[]): Promise<void> {
  const session = await requireAppSession();
  if (!Array.isArray(order)) return;

  const valid = new Set(NAV_ITEMS.map((item) => item.href));
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const href of order) {
    if (typeof href !== "string") continue;
    if (!valid.has(href)) continue;
    if (seen.has(href)) continue;
    clean.push(href);
    seen.add(href);
  }

  await db
    .update(schema.users)
    .set({ navOrder: clean })
    .where(eq(schema.users.id, session.userId));
  await setNavOrderCookie(clean);
}
