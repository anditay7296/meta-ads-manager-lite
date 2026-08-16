/**
 * Phase 0.13 invite-only gating.
 *
 * Reads ALLOWED_EMAILS from env (comma-separated). If unset, all emails are
 * allowed (development convenience). For invite-only v1, set this in production.
 *
 * Phase 1+ will replace this with the proper `invites` table flow + per-email
 * tokens; this env-based check stays as the safety net.
 */
export function isEmailAllowed(email: string | null | undefined): boolean {
  if (!email) return false;
  const raw = process.env.ALLOWED_EMAILS?.trim();
  if (!raw) return true;
  const allowed = new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
  return allowed.has(email.toLowerCase());
}
