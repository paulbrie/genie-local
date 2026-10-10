import { cn } from "@/lib/utils";

const SIZE = { sm: "size-1.5", md: "size-2", lg: "size-2.5" } as const;

/**
 * A small status indicator dot: a solid coloured dot with an optional "live"
 * halo. One primitive behind every status dot in the app — pass the Tailwind
 * background class for the dot and the halo reuses it. The halo pings three
 * times when the status changes (it turns live, or its colour changes), then
 * stays as a still, soft ring: an endless ping kept every page repainting
 * (T143/T162). No ping under prefers-reduced-motion.
 * Callers holding a domain status (terminal / run / running) map it to
 * `color` + `pulse`, and — where it helps screen readers — a `label`, which
 * also becomes the tooltip.
 */
export function StatusDot({
  color,
  pulse = false,
  size = "md",
  label,
  className,
}: {
  /** Tailwind background class for the dot, e.g. `"bg-emerald-500"`. */
  color: string;
  /** Show the live halo (for "live"/active states): a few pings on a change, then a still ring. */
  pulse?: boolean;
  size?: keyof typeof SIZE;
  /** Accessible label; also the tooltip. Omit for a purely decorative dot. */
  label?: string;
  className?: string;
}) {
  const s = SIZE[size];
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      title={label}
      className={cn(
        "relative flex shrink-0 items-center justify-center",
        s,
        className,
      )}
    >
      {pulse && (
        <>
          <span
            aria-hidden
            className={cn("absolute -inset-[2px] rounded-full opacity-35", color)}
          />
          {/* (keyed by the colour: a new status pings again) */}
          <span
            key={color}
            aria-hidden
            className={cn(
              "absolute inline-flex size-full rounded-full opacity-0 animate-status-ping motion-reduce:hidden",
              color,
            )}
          />
        </>
      )}
      <span className={cn("relative inline-flex rounded-full", s, color)} />
    </span>
  );
}
