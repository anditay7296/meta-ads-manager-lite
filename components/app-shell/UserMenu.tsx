import { getAppSession } from "@/lib/auth/session";

/**
 * Shows who the app is acting as. There is no sign-out button because there
 * is no sign-in — see lib/auth/session.ts. Access control is handled outside
 * the app (Vercel Deployment Protection).
 */
export async function UserMenu() {
  const session = await getAppSession();
  if (!session) return null;
  return (
    <div className="flex items-center gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800">
      <div className="grid h-7 w-7 place-items-center rounded-full bg-zinc-200 text-[11px] font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
        {session.email.slice(0, 2).toUpperCase()}
      </div>
      <span className="flex-1 truncate text-xs text-zinc-700 dark:text-zinc-300">
        {session.email}
      </span>
    </div>
  );
}
