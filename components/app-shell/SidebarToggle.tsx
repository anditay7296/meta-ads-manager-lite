"use client";

import { PanelLeft } from "lucide-react";
import { useSidebar } from "@/lib/stores/sidebar";

export function SidebarToggle() {
  const toggleMobile = useSidebar((s) => s.toggleMobile);
  const toggleDesktop = useSidebar((s) => s.toggleDesktop);

  const onClick = () => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(min-width: 1024px)").matches
    ) {
      toggleDesktop();
    } else {
      toggleMobile();
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Toggle sidebar"
      className="-ml-2 mr-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-700 hover:bg-zinc-200/60 dark:text-zinc-200 dark:hover:bg-zinc-800"
    >
      <PanelLeft className="h-4 w-4" />
    </button>
  );
}
