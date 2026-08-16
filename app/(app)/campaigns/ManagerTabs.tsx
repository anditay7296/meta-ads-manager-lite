import Link from "next/link";
import { Megaphone, LayoutGrid, Image as ImageIcon, Copy, Sparkles } from "lucide-react";

type Tab = "campaigns" | "adsets" | "ads" | "clone-jobs" | "factory";

const TABS: Array<{
  id: Tab;
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: "campaigns", label: "Campaigns", href: "/campaigns", icon: Megaphone },
  { id: "adsets", label: "Ad sets", href: "/campaigns/adsets", icon: LayoutGrid },
  { id: "ads", label: "Ads", href: "/campaigns/ads", icon: ImageIcon },
  { id: "clone-jobs", label: "Clone jobs", href: "/campaigns/clone-jobs", icon: Copy },
  { id: "factory", label: "Factory", href: "/campaigns/factory", icon: Sparkles },
];

export function ManagerTabs({ active }: { active: Tab }) {
  return (
    <div className="flex border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      {TABS.map((t) => {
        const Icon = t.icon;
        const isActive = t.id === active;
        return (
          <Link
            key={t.id}
            href={t.href}
            className={`flex items-center gap-2 border-b-2 px-6 py-3 text-sm transition-colors ${
              isActive
                ? "border-blue-600 text-blue-600 dark:text-blue-400"
                : "border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-900 dark:hover:border-zinc-700 dark:hover:text-zinc-100"
            }`}
          >
            <Icon className="h-4 w-4" />
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
