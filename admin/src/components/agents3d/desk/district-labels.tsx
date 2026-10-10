"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { memo, useEffect, useMemo } from "react";
import type * as THREE from "three";

import type { CityLayout } from "@/lib/city-layout";

import { useWantFrame } from "../frame-governor";
import { OverlayLabel } from "../overlay-label";
import { districtSpots, type MiniCities, nearestSpots } from "./world";

/** At most this many neighbourhood names at once: the nearest to the camera. */
export const MAX_DISTRICT_LABELS = 12;
/** Label slots: the shown ones, plus room for those still fading out. */
const SLOTS = MAX_DISTRICT_LABELS + 6;
/** Seconds for a full fade in or out, on the wall clock (as the thought cloud). */
const FADE_S = 0.4;
const LABEL_STYLE = { pointerEvents: "none" } as const;

/**
 * The neighbourhoods' (folders') names on the miniature cities, shown only
 * when the camera comes close (see DISTRICT_LABEL_DIST; deeper folders need
 * closer), so the table isn't cluttered from afar. A fixed pool of labels,
 * moved and refilled in place: nothing is allocated or re-rendered per frame.
 */
export const DistrictLabels = memo(function DistrictLabels({ layout, mini, reduced }: { layout: CityLayout; mini: MiniCities; reduced: boolean }) {
  const camera = useThree((s) => s.camera);
  const wantFrame = useWantFrame();
  const spots = useMemo(() => districtSpots(layout, mini), [layout, mini]);
  const pool = useMemo(
    () => ({
      idx: new Int32Array(MAX_DISTRICT_LABELS),
      d2: new Float32Array(MAX_DISTRICT_LABELS),
      // Per slot: the district shown (-1: free), its opacity, and its DOM nodes.
      spot: new Int32Array(SLOTS).fill(-1),
      alpha: new Float32Array(SLOTS),
      groups: new Array<THREE.Group | null>(SLOTS).fill(null),
      els: new Array<HTMLDivElement | null>(SLOTS).fill(null),
      last: 0,
    }),
    [],
  );
  // A new layout starts from an empty pool: hide what the old one showed.
  useEffect(() => {
    pool.spot.fill(-1);
    pool.alpha.fill(0);
    for (const el of pool.els) if (el) el.style.opacity = "0";
  }, [spots, pool]);

  useFrame(() => {
    const p = pool;
    const now = performance.now();
    // The fade's step from wall-clock time, not the capped frame step (a dropped frame doesn't stretch it).
    const step = p.last ? (now - p.last) / 1000 / FADE_S : 1;
    p.last = now;
    const n = nearestSpots(camera.position.x, camera.position.y, camera.position.z, spots, p.idx, p.d2);
    // New names into free slots.
    for (let k = 0; k < n; k++) {
      const di = p.idx[k];
      let has = false;
      let free = -1;
      for (let s = 0; s < SLOTS; s++) {
        if (p.spot[s] === di) has = true;
        else if (free < 0 && p.spot[s] < 0) free = s;
      }
      const g = free >= 0 ? p.groups[free] : null;
      const el = free >= 0 ? p.els[free] : null;
      if (has || !g || !el) continue;
      p.spot[free] = di;
      p.alpha[free] = 0;
      g.position.set(spots.x[di], spots.y[di], spots.z[di]);
      el.textContent = spots.names[di];
    }
    // Fade in the wanted ones and out the rest; a faded-out slot is free again.
    for (let s = 0; s < SLOTS; s++) {
      const di = p.spot[s];
      if (di < 0) continue;
      let want = 0;
      for (let k = 0; k < n; k++) if (p.idx[k] === di) want = 1;
      const a = reduced ? want : p.alpha[s] + Math.sign(want - p.alpha[s]) * Math.min(Math.abs(want - p.alpha[s]), step);
      if (a !== p.alpha[s] || a === 0) {
        p.alpha[s] = a;
        const el = p.els[s];
        if (el) el.style.opacity = String(a);
      }
      if (a === 0 && !want) p.spot[s] = -1;
      // Still fading: frames until it's done (camera moves bring their own).
      if (a !== want) wantFrame(30);
    }
  });

  return (
    <group>
      {Array.from({ length: SLOTS }, (_, s) => (
        <group
          key={s}
          ref={(g) => {
            pool.groups[s] = g;
          }}
        >
          <OverlayLabel center zIndexRange={[10, 0]} style={LABEL_STYLE}>
            <div
              ref={(el) => {
                pool.els[s] = el;
              }}
              className="whitespace-nowrap rounded bg-slate-900/60 px-1 py-px text-[9px] font-medium tracking-wide text-amber-100/90"
              style={{ opacity: 0 }}
            />
          </OverlayLabel>
        </group>
      ))}
    </group>
  );
});
