"use client";

import { useMemo } from "react";

import type { TLAgent } from "@/lib/agents3d-timeline";
import type { BrowserSession } from "@/lib/browsers";

import { OverlayLabel } from "../overlay-label";
import { type BrowserLook, browserLook, seatBrowsers } from "./browser-look";
import { LEVEL_COLORS } from "./gauge-levels";
import { browserAt, seatAt, UNOWNED_BROWSERS } from "./world";

/** Labels float this high over the table (where the browser's screen stood, T102). */
const LABEL_Y = 1.6;
const LABEL_STYLE = { pointerEvents: "none" } as const;

/** One browser's label: "🌐 host · n% CPU", the CPU coloured by its level. */
function BrowserLabel({ look, text, x, z }: { look: BrowserLook; text: string; x: number; z: number }) {
  return (
    <OverlayLabel position={[x, LABEL_Y, z]} center zIndexRange={[15, 0]} style={LABEL_STYLE}>
      <div className="whitespace-nowrap rounded-full bg-black/70 px-1.5 py-0.5 text-[9px] text-white/85 shadow">
        <span className="mr-0.5">🌐</span>
        {text}
        <span className="ml-1 font-semibold" style={{ color: LEVEL_COLORS[look.level] }}>
          {look.cpuText}
        </span>
      </div>
    </OverlayLabel>
  );
}

/**
 * Who is using a browser (agent-browser with Chrome running): a label in front
 * of the owner's laptop with its page's host and the browser's CPU, "+n" for
 * more sessions; sessions nobody at the table owns share one label in the front
 * gap, marked as unowned. Data from Alex's useBrowsers (every 5 s); no 3D, no per-frame work.
 */
export function DeskBrowsers({ cast, sessions }: { cast: TLAgent[]; sessions: BrowserSession[] }) {
  const { byAgent, unowned } = useMemo(() => seatBrowsers(cast, sessions), [cast, sessions]);
  return (
    <group>
      {cast.map((a, i) => {
        const list = byAgent.get(a.key);
        if (!list) return null;
        const at = browserAt(seatAt(i, cast.length));
        const look = browserLook(list[0], list.length - 1);
        return <BrowserLabel key={a.key} look={look} text={`${look.host || "browser"}${look.more ? ` +${look.more}` : ""}`} x={at.x} z={at.z} />;
      })}
      {unowned.length > 0 && (
        <BrowserLabel
          look={browserLook(unowned[0])}
          text={`unowned: ${unowned[0].session}${unowned.length > 1 ? ` +${unowned.length - 1}` : ""}`}
          x={UNOWNED_BROWSERS.x}
          z={UNOWNED_BROWSERS.z}
        />
      )}
    </group>
  );
}
