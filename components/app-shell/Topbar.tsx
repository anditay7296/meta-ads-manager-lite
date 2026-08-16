import { SidebarToggle } from "./SidebarToggle";

/**
 * Every one of the four surfaces renders a Topbar, so it carries the sidebar
 * toggle. In the parent app that toggle lived in the ProjectBar, which Lite
 * drops (single project) — without it the sidebar, and the sign-out control
 * in its footer, are unreachable below 1024px.
 *
 * The parent's "Ask agent" button is gone with the /agent route.
 */
export function Topbar({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-zinc-200 bg-white px-4 sm:px-6 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex min-w-0 items-center">
        <SidebarToggle />
        <div className="flex min-w-0 flex-col leading-tight">
          <h1 className="truncate text-sm font-semibold">{title}</h1>
          {subtitle ? (
            <span className="truncate text-[11px] text-zinc-500">{subtitle}</span>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </div>
  );
}
