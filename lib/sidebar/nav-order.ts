import { cookies } from "next/headers";

const COOKIE = "nav_order";
const MAX_AGE = 60 * 60 * 24 * 365;

export async function getNavOrderCookie(): Promise<string[] | null> {
  const store = await cookies();
  const raw = store.get(COOKIE)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return null;
  }
}

export async function setNavOrderCookie(order: string[]): Promise<void> {
  const store = await cookies();
  store.set(COOKIE, JSON.stringify(order), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
}
