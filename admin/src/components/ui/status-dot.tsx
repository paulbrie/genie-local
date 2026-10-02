import { cn } from "@/lib/utils";

const SIZE = { sm: "size-1.5", md: "size-2", lg: "size-2.5" } as const;

/**
 * A small status indicator dot: a solid coloured dot with an optional pulsing
 * halo (the classic "live" ping). One primitive behind every status dot in the
 * app — pass the Tailwind background class for the dot and the halo reuses it.
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
  /** Render the animated ping halo (for "live"/active states). */
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
        <span
          className={cn(
            "absolute inline-flex size-full animate-ping rounded-full opacity-70",
            color,
          )}
        />
      )}
      <span className={cn("relative inline-flex rounded-full", s, color)} />
    </span>
  );
}
