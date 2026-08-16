import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/auth/middleware";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Run on every route except Next internals + static assets.
    // `.webmanifest` is excluded so the PWA manifest stays publicly fetchable —
    // browsers request it without credentials, so gating it breaks home-screen install.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|webmanifest)$).*)",
  ],
};
