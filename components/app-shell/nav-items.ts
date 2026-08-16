import {
  LayoutDashboard,
  Megaphone,
  ShieldCheck,
  Type,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  hint?: string;
};

/**
 * Lite ships four surfaces. The parent app's Content, Creatives, AI Agent,
 * Morning Briefs, Decision Journal, Andigram, Manual, Integrations and
 * Settings pages are deliberately absent.
 */
export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, hint: "Reporting" },
  { href: "/campaigns", label: "Campaigns", icon: Megaphone, hint: "Create & edit" },
  { href: "/copy", label: "Copywriting", icon: Type },
  { href: "/rules", label: "Automated Rules", icon: ShieldCheck, hint: "Dry-run" },
];

export function resolveNavOrder(
  savedHrefs: string[] | null | undefined,
): NavItem[] {
  if (!savedHrefs || savedHrefs.length === 0) return NAV_ITEMS;
  const byHref = new Map(NAV_ITEMS.map((item) => [item.href, item]));
  const seen = new Set<string>();
  const ordered: NavItem[] = [];
  for (const href of savedHrefs) {
    if (seen.has(href)) continue;
    const item = byHref.get(href);
    if (!item) continue;
    ordered.push(item);
    seen.add(href);
  }
  for (const item of NAV_ITEMS) {
    if (!seen.has(item.href)) ordered.push(item);
  }
  return ordered;
}
