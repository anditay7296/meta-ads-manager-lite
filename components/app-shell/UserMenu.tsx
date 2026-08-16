import { LogOut } from "lucide-react";
import { getAppSession } from "@/lib/auth/session";

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
      <form action="/api/auth/signout" method="post">
        <button
          type="submit"
          aria-label="Sign out"
          className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <LogOut className="h-3.5 w-3.5" />
        </button>
      </form>
    </div>
  );
}
