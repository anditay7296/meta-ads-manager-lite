import { MARK_FACETS, MARK_GRADIENTS, MARK_VIEWBOX, WORDMARK } from "@/lib/brand";
import { cn } from "@/lib/utils";

/**
 * The AI Mastermind mark, inlined as SVG rather than served from /logo.png.
 *
 * Inlining buys three things the old raster couldn't: it stays crisp at every
 * size, it needs no next/image `dangerouslyAllowSVG` escape hatch, and it costs
 * no extra request on first paint. Geometry lives in lib/brand.ts alongside the
 * icon generator, so the sidebar and the home-screen tile share one definition.
 *
 * The mark carries its own colour, so it sits on light and dark backgrounds
 * unchanged — only the wordmark needs a theme-aware fill.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox={MARK_VIEWBOX}
      className={className}
      role="img"
      aria-label={WORDMARK}
    >
      <defs>
        {MARK_GRADIENTS.map((g) => (
          <linearGradient
            key={g.id}
            id={g.id}
            x1={g.x1}
            y1={g.y1}
            x2={g.x2}
            y2={g.y2}
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor={g.from} />
            <stop offset="1" stopColor={g.to} />
          </linearGradient>
        ))}
      </defs>
      {MARK_FACETS.map((f) => (
        <path key={f.fill} d={f.d} fill={`url(#${f.fill})`} />
      ))}
    </svg>
  );
}

/** Mark + wordmark lockup. `markClassName` sizes the mark; the text follows it. */
export function Logo({
  className,
  markClassName = "h-6 w-auto",
  showWordmark = true,
}: {
  className?: string;
  markClassName?: string;
  showWordmark?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <LogoMark className={markClassName} />
      {showWordmark ? (
        <span className="truncate text-[13px] font-semibold tracking-[0.14em] text-zinc-900 dark:text-zinc-50">
          {WORDMARK}
        </span>
      ) : null}
    </div>
  );
}
