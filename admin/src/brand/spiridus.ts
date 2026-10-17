// Pure, dependency-free: safe for server and client.
/**
 * Spiridus, the brand (V2, 17 Oct 2026): the wisp mark, its colours and its
 * motion, ported from the brand research project (/opt/project/projects/
 * genie-brand, src/brand/*; the guideline at /projects/genie-brand/v2).
 *
 * The brand's colours are Catppuccin (Night / Paper grounds; Deep wish / Wish
 * wisps); the admin shows the logo in black and white instead (globals.css
 * --wisp-*, --wordmark): the wisp in the ink, its eyes in the ground. Never
 * peach: that's Claude's colour in the app.
 */

export const NIGHT = "#1e1e2e";
export const PAPER = "#eff1f5";
export const WISH = "#cba6f7";
export const DEEP_WISH = "#8839ef";
export const EYE_WHITE = "#ffffff";

/** The wisp's body on the 32 × 32 grid: a round-bottomed flame, its tip bent right. */
export const WISP_BODY =
  "M16 28.5c-4.4 0-8-3.4-8-7.8 0-5.6 4.6-8.6 8.4-12.4 1.6-1.6 2.4-3.4 2.2-5.3 3.8 1.6 5.4 5.6 5.4 10.2v7.5c0 4.4-3.6 7.8-8 7.8Z";
/** The eyes: ovals low and right of centre, looking ahead. */
export const WISP_EYES = [
  { cx: 13.4, cy: 19.5, rx: 1.7, ry: 2.3 },
  { cx: 18.8, cy: 19.5, rx: 1.7, ry: 2.3 },
] as const;

/**
 * The states the app's wisp shows (loops) and the moments it plays once.
 * Below 24 px only blink and flicker read; look and wink are fine at the
 * sidebar's size since they don't depend on detail.
 */
export type WispMotion = "still" | "blink" | "flicker" | "look" | "wink";

/**
 * The motion CSS (from genie-brand src/brand/motion.ts), scoped by .sp-* classes
 * so it can't clash with the page. Stops under prefers-reduced-motion.
 */
export const WISP_CSS = `.sp *{transform-box:fill-box;transform-origin:50% 50%}
.sp .sp-root,.sp .sp-body{transform-origin:50% 100%}
@keyframes sp-blink{0%,90%,93%,95%,98%,100%{transform:scaleY(1)}91.5%,96.5%{transform:scaleY(.1)}}
.sp-blink .sp-eye{animation:sp-blink 5s infinite}
.sp-flicker .sp-body{animation:sp-flicker 1.4s ease-in-out infinite}
.sp-flicker .sp-root{animation:sp-bob 1.4s ease-in-out infinite}
.sp-flicker .sp-eye{animation:sp-blink 5s 1s infinite}
@keyframes sp-flicker{0%,100%{transform:skewX(0) scaleY(1)}30%{transform:skewX(-8deg) scaleY(1.05)}65%{transform:skewX(4deg) scaleY(.97)}}
@keyframes sp-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-1px)}}
.sp-look .sp-eyes{animation:sp-look 3.2s ease-in-out infinite}
.sp-look .sp-root{animation:sp-lean 3.2s ease-in-out infinite}
@keyframes sp-look{0%,12%,88%,100%{transform:translate(0,0)}25%,45%{transform:translate(-1.8px,0)}58%,78%{transform:translate(1.6px,-.8px)}}
@keyframes sp-lean{0%,12%,88%,100%{transform:rotate(0)}25%,45%{transform:rotate(-4deg)}58%,78%{transform:rotate(4deg)}}
.sp-wink .sp-eye-r{animation:sp-wink .9s ease-in-out both}
.sp-wink .sp-root{animation:sp-tilt .9s ease-in-out both}
@keyframes sp-wink{0%,20%,72%,100%{transform:scaleY(1)}30%,62%{transform:scaleY(.12)}}
@keyframes sp-tilt{0%,100%{transform:rotate(0)}30%,62%{transform:rotate(-9deg)}}
@media (prefers-reduced-motion:reduce){.sp *{animation:none!important}}`;

/**
 * The favicon, monochrome like the admin's logo: a black wisp with white eyes
 * on light browser chrome, white with black eyes on dark.
 */
export const WISP_ICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
  `<style>.b{fill:#0a0a0a}.e{fill:#ffffff}@media (prefers-color-scheme:dark){.b{fill:#fafafa}.e{fill:#0a0a0a}}</style>` +
  `<path class="b" d="${WISP_BODY}"/>` +
  WISP_EYES.map((e) => `<ellipse class="e" cx="${e.cx}" cy="${e.cy}" rx="${e.rx}" ry="${e.ry}"/>`).join("") +
  `</svg>`;
