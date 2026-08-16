import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatMyr(amount: number | string | null | undefined): string {
  if (amount === null || amount === undefined) return "—";
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-MY", {
    style: "currency",
    currency: "MYR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

export function formatNumber(n: number | string | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const num = typeof n === "string" ? Number(n) : n;
  if (!Number.isFinite(num)) return "—";
  return new Intl.NumberFormat("en-MY").format(num);
}

/**
 * Single source of truth for status emoji used across the dashboard, the
 * web approval card, and the Telegram message formatter — so what you see
 * in the chat matches what you see in the app.
 */
export type StatusKind = "keep" | "kill" | "caution" | "urgent" | "info";

export function statusEmoji(kind: StatusKind): string {
  switch (kind) {
    case "keep":
      return "🟢";
    case "kill":
      return "🔴";
    case "caution":
      return "🟡";
    case "urgent":
      return "⚡";
    case "info":
      return "📍";
  }
}

export type ProposalKind =
  | "pause_ads"
  | "resume_ads"
  | "publish_post"
  | "publish_story"
  | "create_rule"
  | "update_budget"
  | "create_ad_set"
  | "sync_aia_missing"
  | "boost_existing_post"
  | "scale_to_gt2"
  | "clone_gt1_to_gt2"
  | "sync_gt1_siblings"
  | "deploy_gt1_scaffold";

/** Shared between the web ApprovalCard and the Telegram message formatter. */
export const PROPOSAL_EMOJI: Record<ProposalKind, string> = {
  pause_ads: "🔴",
  resume_ads: "🟢",
  publish_post: "📣",
  publish_story: "📸",
  create_rule: "⚙️",
  update_budget: "💰",
  create_ad_set: "📦",
  sync_aia_missing: "🔄",
  boost_existing_post: "🚀",
  scale_to_gt2: "📈",
  clone_gt1_to_gt2: "🧬",
  sync_gt1_siblings: "🪞",
  deploy_gt1_scaffold: "🆕",
};
