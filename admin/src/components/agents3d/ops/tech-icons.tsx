"use client";

import type { TechIcon } from "./tech";

/**
 * The technologies' marks on the gateway's port boxes (T217): simplified, monochrome, in a 24 × 24 box, drawn in the
 * tech's colour (no dependency, no brand artwork: a recognisable shape for each, its name in the box's tooltip).
 */
export function TechMark({ icon, color }: { icon: TechIcon; color: string }) {
  const s = { fill: "none", stroke: color, strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (icon) {
    case "terminal": // (a prompt: a chevron and a cursor)
      return <g {...s}><rect x={2.5} y={4} width={19} height={16} rx={2} /><path d="M7 10l3 2.5L7 15" /><path d="M12.5 15.5h4.5" /></g>;
    case "nginx": // (an N in a hexagon)
      return <g {...s}><path d="M12 2.5l8.5 4.9v9.2L12 21.5l-8.5-4.9V7.4z" /><path d="M9 16V8l6 8V8" /></g>;
    case "next": // (an N in a circle, its right stroke trailing off)
      return <g {...s}><circle cx={12} cy={12} r={9.5} /><path d="M9 16V8l7.5 10.5M15.5 8v5" /></g>;
    case "node": // (a hexagon with a small js)
      return <g {...s}><path d="M12 2.5l8.5 4.9v9.2L12 21.5l-8.5-4.9V7.4z" /><path d="M10 9v5.5a1.5 1.5 0 0 1-3 0M16.5 9.8c-.6-.6-1.4-.8-2.1-.6-.9.3-1 1.5-.1 1.9l1.2.5c.9.4.8 1.7-.1 2-.8.3-1.7 0-2.2-.6" /></g>;
    case "postgres": // (a database: a stacked cylinder)
      return <g {...s}><ellipse cx={12} cy={5.5} rx={7.5} ry={2.8} /><path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" /></g>;
    case "docker": // (containers stacked on a hull)
      return <g {...s}><path d="M2.5 12.5h18c-.5 4-3.8 7-8.7 7-4.6 0-7.8-2.6-9.3-7z" /><rect x={5} y={8.5} width={3.2} height={3} /><rect x={8.8} y={8.5} width={3.2} height={3} /><rect x={12.6} y={8.5} width={3.2} height={3} /><rect x={8.8} y={4.8} width={3.2} height={3} /><path d="M19 10c.8-1 2-1.2 2.8-.8" /></g>;
    case "python": // (two interlocked rounded halves)
      return <g {...s}><path d="M12 3c-4 0-4 1.6-4 3v2.5h4.5v1H6c-2 0-3 1.5-3 3.8S4 17 6 17h1.5v-2.4c0-1.4 1-2.6 2.6-2.6h4c1.3 0 2.4-1 2.4-2.4V6c0-1.6-1.6-3-4.5-3z" /><path d="M12 21c4 0 4-1.6 4-3v-2.5h-4.5v-1H18c2 0 3-1.5 3-3.8S20 7 18 7h-1.5" /><circle cx={10} cy={5.6} r={0.6} /><circle cx={14} cy={18.4} r={0.6} /></g>;
    case "caddy": // (a padlock: automatic HTTPS)
      return <g {...s}><rect x={5} y={10.5} width={14} height={10} rx={2} /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3M12 14.5v2.5" /></g>;
    case "apache": // (a feather)
      return <g {...s}><path d="M19.5 3.5C12 5 7 11 5 20.5c4.5-3 9.5-6.5 12-11 1-1.8 1.8-3.8 2.5-6z" /><path d="M5 20.5l7-8" /></g>;
    case "redis": // (stacked layers)
      return <g {...s}><path d="M3 8.5L12 5l9 3.5-9 3.5z" /><path d="M3 12.5l9 3.5 9-3.5M3 16.5l9 3.5 9-3.5" /></g>;
    case "globe": // (the web)
      return <g {...s}><circle cx={12} cy={12} r={9.5} /><path d="M2.5 12h19M12 2.5c3 3 3 16 0 19M12 2.5c-3 3-3 16 0 19" /></g>;
    case "network": // (linked nodes)
      return <g {...s}><circle cx={12} cy={5} r={2.5} /><circle cx={5} cy={18} r={2.5} /><circle cx={19} cy={18} r={2.5} /><path d="M10.8 7.2L6.2 15.8M13.2 7.2l4.6 8.6M7.5 18h9" /></g>;
  }
}
