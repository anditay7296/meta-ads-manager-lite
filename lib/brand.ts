/**
 * The AI Mastermind mark — single source of truth for the logo geometry and
 * palette. Imported by both `components/app-shell/Logo.tsx` (renders it as JSX)
 * and `scripts/generate-icons.ts` (bakes it into the favicon / PWA tiles), so
 * the sidebar and the home-screen icon can never drift apart.
 *
 * The mark is two splayed chevrons drawn in a 240-unit box, bbox 32..208 x
 * 72..168. Each chevron is folded down the centre of its peak, which splits the
 * flat top into two facets — that fold is what gives the ribbon look. Facets are
 * painted L-to-R violet → orchid → blue → cyan, and the two inner facets are
 * drawn last so the light orchid crosses over the blue and leaves the blue wedge
 * showing at bottom-centre.
 *
 * Peaks are rounded with a quadratic rather than an arc: at this radius the two
 * are indistinguishable, and it keeps the path short enough to inline in the
 * favicon without a second HTTP round trip.
 */

/** Facet paths, in draw order. Outer two first, then the inner (lighter) pair. */
export const MARK_FACETS = [
  // Far left, down-left — violet.
  { d: "M32 168L74.5 77.4Q77 72 83 72H90V100L58 168Z", fill: "amm-a" },
  // Far right, down-right — blue into cyan.
  { d: "M149 72H156Q162 72 164.6 77.4L208 168H182L149 100Z", fill: "amm-d" },
  // Inner right, rising to the right peak — orchid into blue.
  { d: "M90 168L133.4 77.4Q136 72 142 72H149V100L116 168Z", fill: "amm-c" },
  // Inner left, falling from the left peak — the lightest facet, drawn last.
  { d: "M90 72H97Q103 72 105.5 77.4L148 168H122L90 100Z", fill: "amm-b" },
] as const;

/** Facet gradients, run along each facet's own axis so the fold reads cleanly. */
export const MARK_GRADIENTS = [
  { id: "amm-a", x1: 83, y1: 72, x2: 45, y2: 168, from: "#8B5CF6", to: "#6D28D9" },
  { id: "amm-b", x1: 96, y1: 72, x2: 135, y2: 168, from: "#F0CFFE", to: "#A855F7" },
  { id: "amm-c", x1: 142, y1: 72, x2: 103, y2: 168, from: "#E8C4FB", to: "#2E9BF7" },
  { id: "amm-d", x1: 155, y1: 72, x2: 195, y2: 168, from: "#3B82F6", to: "#22C0F5" },
] as const;

/** Tight viewBox around the mark — use when it sits on the app's own background. */
export const MARK_VIEWBOX = "32 72 176 96";

/** The dark tile the mark sits on in the icon set, matching the source lockup. */
export const TILE_BG_FROM = "#1E1733";
export const TILE_BG_TO = "#0D0A18";

/** Browser/PWA accent. Picked off the mark's violet so the two read as one brand. */
export const BRAND_ACCENT = "#7C3AED";

/** Wordmark shown beside the mark. Set in the UI font, tracked out wide. */
export const WORDMARK = "AI MASTERMIND";
