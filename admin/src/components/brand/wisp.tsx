import { WISP_BODY, WISP_CSS, WISP_EYES, type WispMotion } from "@/brand/spiridus";
import { cn } from "@/lib/utils";

/**
 * The Spiridus wisp, inline, in the theme's brand colours (--wisp-body /
 * --wisp-eyes, globals.css: Deep wish + white eyes on light, Wish + Night eyes
 * on dark) and in a motion state. Drawn on the 32-unit grid with room around it
 * for the bob / lean, so it never clips.
 */
export function Wisp({
  size = 24,
  motion = "still",
  title = "Spiridus",
  className,
}: {
  size?: number;
  motion?: WispMotion;
  /** Accessible name; pass "" when a wordmark beside it already says it. */
  title?: string;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      role={title ? "img" : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      className={cn("shrink-0 overflow-visible", className)}
    >
      <style>{WISP_CSS}</style>
      <g className={`sp sp-${motion}`}>
        <g className="sp-root">
          <path className="sp-body" d={WISP_BODY} fill="var(--wisp-body)" />
          <g className="sp-eyes" fill="var(--wisp-eyes)">
            {WISP_EYES.map((e, i) => (
              <ellipse
                key={i}
                className={`sp-eye ${i === 0 ? "sp-eye-l" : "sp-eye-r"}`}
                cx={e.cx}
                cy={e.cy}
                rx={e.rx}
                ry={e.ry}
              />
            ))}
          </g>
        </g>
      </g>
    </svg>
  );
}

/**
 * The lockup: the wisp with the wordmark, lowercase "spiridus" in Fredoka
 * SemiBold. Horizontal: the word at 0.9 × the mark's height, ¼ mark apart.
 * Stacked: the word under the mark at half its height.
 */
export function Lockup({
  size = 24,
  layout = "horizontal",
  motion = "still",
  className,
}: {
  size?: number;
  layout?: "horizontal" | "stacked";
  motion?: WispMotion;
  className?: string;
}) {
  const stacked = layout === "stacked";
  return (
    <span
      className={cn("inline-flex items-center", stacked && "flex-col", className)}
      style={{ gap: size * (stacked ? 0.18 : 0.25) }}
    >
      <Wisp size={size} motion={motion} title="" />
      <span
        className="font-wordmark leading-none"
        style={{
          color: "var(--wordmark)",
          fontSize: size * (stacked ? 0.5 : 0.9),
          fontWeight: 600,
          letterSpacing: "-0.01em",
        }}
      >
        spiridus
      </span>
    </span>
  );
}
