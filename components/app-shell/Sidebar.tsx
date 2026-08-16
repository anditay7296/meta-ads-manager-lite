"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSidebar } from "@/lib/stores/sidebar";
import { resolveNavOrder, type NavItem } from "./nav-items";
import { saveNavOrderAction } from "./nav-order-actions";

type DropPosition = "before" | "after";

export function Sidebar({
  initialOrderHrefs,
  footer,
}: {
  initialOrderHrefs: string[] | null;
  footer?: React.ReactNode;
}) {
  const pathname = usePathname();
  const mobileOpen = useSidebar((s) => s.mobileOpen);
  const setMobileOpen = useSidebar((s) => s.setMobileOpen);
  const desktopHidden = useSidebar((s) => s.desktopHidden);
  const hydrate = useSidebar((s) => s.hydrate);

  const [order, setOrder] = useState<NavItem[]>(() =>
    resolveNavOrder(initialOrderHrefs),
  );
  const [draggingHref, setDraggingHref] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<
    { href: string; position: DropPosition } | null
  >(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname, setMobileOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setMobileOpen]);

  // Pick the most-specific NAV item whose href is a prefix of pathname.
  const activeHref = order.reduce<string | null>((best, item) => {
    if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
      if (!best || item.href.length > best.length) return item.href;
    }
    return best;
  }, null);

  function handleDragStart(href: string) {
    return (e: React.DragEvent<HTMLDivElement>) => {
      setDraggingHref(href);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", href);
    };
  }

  function handleDragOver(href: string) {
    return (e: React.DragEvent<HTMLDivElement>) => {
      if (!draggingHref || draggingHref === href) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = e.currentTarget.getBoundingClientRect();
      const position: DropPosition =
        e.clientY < rect.top + rect.height / 2 ? "before" : "after";
      setDropTarget((prev) =>
        prev?.href === href && prev.position === position
          ? prev
          : { href, position },
      );
    };
  }

  function handleDragLeave() {
    setDropTarget(null);
  }

  function handleDrop(targetHref: string) {
    return (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const sourceHref = draggingHref;
      const position = dropTarget?.position ?? "before";
      setDraggingHref(null);
      setDropTarget(null);
      if (!sourceHref || sourceHref === targetHref) return;

      const next = [...order];
      const fromIdx = next.findIndex((i) => i.href === sourceHref);
      if (fromIdx === -1) return;
      const [moved] = next.splice(fromIdx, 1);
      let toIdx = next.findIndex((i) => i.href === targetHref);
      if (toIdx === -1) return;
      if (position === "after") toIdx += 1;
      next.splice(toIdx, 0, moved);

      setOrder(next);
      void saveNavOrderAction(next.map((i) => i.href)).catch(() => {
        // Persistence failure is non-fatal — the cookie will rewrite on the next successful save.
      });
    };
  }

  function handleDragEnd() {
    setDraggingHref(null);
    setDropTarget(null);
  }

  return (
    <>
      {mobileOpen ? (
        <div
          onClick={() => setMobileOpen(false)}
          aria-hidden
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
        />
      ) : null}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex h-full w-60 shrink-0 flex-col border-r border-zinc-200 bg-white transition-transform duration-200 dark:border-zinc-800 dark:bg-zinc-950",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          desktopHidden ? "lg:hidden" : "lg:static lg:translate-x-0",
        )}
      >
        <div className="flex h-14 items-center gap-2 px-4 border-b border-zinc-200 dark:border-zinc-800">
          <Image src="/logo.png" alt="AI Freedom Business" width={80} height={32} className="h-8 w-auto object-contain" />
        </div>
        <nav className="flex-1 overflow-y-auto p-2">
          {order.map((item) => {
            const active = item.href === activeHref;
            const Icon = item.icon;
            const isDragging = draggingHref === item.href;
            const showIndicatorBefore =
              dropTarget?.href === item.href && dropTarget.position === "before";
            const showIndicatorAfter =
              dropTarget?.href === item.href && dropTarget.position === "after";
            return (
              <div
                key={item.href}
                draggable
                onDragStart={handleDragStart(item.href)}
                onDragOver={handleDragOver(item.href)}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop(item.href)}
                onDragEnd={handleDragEnd}
                className={cn(
                  "group relative",
                  isDragging && "opacity-40",
                )}
              >
                {showIndicatorBefore ? (
                  <div className="absolute inset-x-2 -top-px h-0.5 rounded bg-blue-500" />
                ) : null}
                {showIndicatorAfter ? (
                  <div className="absolute inset-x-2 -bottom-px h-0.5 rounded bg-blue-500" />
                ) : null}
                <Link
                  href={item.href}
                  onClick={() => setMobileOpen(false)}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                    active
                      ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                      : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900",
                  )}
                >
                  <GripVertical
                    className="h-3.5 w-3.5 shrink-0 cursor-grab text-zinc-300 opacity-0 transition-opacity group-hover:opacity-100 dark:text-zinc-600"
                    aria-hidden
                  />
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="flex-1">{item.label}</span>
                  {item.hint ? (
                    <span className="text-[10px] uppercase tracking-wider text-zinc-400">
                      {item.hint}
                    </span>
                  ) : null}
                </Link>
              </div>
            );
          })}
        </nav>
        {footer}
      </aside>
    </>
  );
}
