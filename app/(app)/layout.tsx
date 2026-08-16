import { Sidebar } from "@/components/app-shell/Sidebar";
import { UserMenu } from "@/components/app-shell/UserMenu";
import { getNavOrderCookie } from "@/lib/sidebar/nav-order";

// No ProjectBar here, unlike the parent app: Lite holds a single project
// covering the two allowlisted ad accounts, so there is nothing to switch
// between. Use the ad-account filter on /campaigns to narrow to one account.

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const savedOrderHrefs = await getNavOrderCookie();
  return (
    <div className="flex h-screen w-full bg-zinc-50 dark:bg-zinc-950">
      <Sidebar initialOrderHrefs={savedOrderHrefs} footer={<UserMenu />} />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex flex-1 flex-col overflow-hidden">{children}</div>
      </main>
    </div>
  );
}
