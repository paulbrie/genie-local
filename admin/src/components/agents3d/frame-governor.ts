"use client";

import { useThree } from "@react-three/fiber";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/**
 * Frames on demand for the 3D views' Canvases (`frameloop="demand"`). A
 * still scene draws nothing; R3F draws a frame when a prop changes or
 * `invalidate()` is called (drei's OrbitControls do, while moved or damping).
 * Whatever animates asks for its next frame from its own `useFrame`, every
 * frame it still moves: `want(30)` = "draw again within 1/30 s". The
 * soonest request wins; a frame not asked for again is the last one. In a
 * hidden tab nothing is drawn (R3F's rAF is paused).
 *
 * A prop that changes identity on a re-render counts as an update and draws
 * a frame: the views re-render 4× a second (the clock), so R3F elements get
 * stable event handlers (`useStableHandler`) and memoized objects.
 */
type Governor = { want: (fps: number, kind?: FrameKind) => void };
/** what a frame is for: "ambient" = idle motion that goes on while nothing happens (a busy drone bobbing, a busy avatar typing) */
export type FrameKind = "event" | "ambient";

/**
 * Low power (T162): every frame at most 30 a second, ambient motion at most 15. Set by the view (its switch); one
 * page shows one 3D view, so a module setting is enough.
 */
let lowPower = false;
export function setLowPowerFrames(on: boolean) {
  lowPower = on;
}
/** the rate a request is held to (low power: 30, ambient 15) */
export const cappedFps = (fps: number, kind: FrameKind = "event", low = lowPower) => (low ? Math.min(fps, kind === "ambient" ? 15 : 30) : fps);

const governors = new WeakMap<() => void, Governor>();

function governorFor(invalidate: () => void): Governor {
  let g = governors.get(invalidate);
  if (g) return g;
  let due = Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = () => {
    timer = undefined;
    due = Infinity;
    invalidate();
  };
  g = {
    want(asked, kind) {
      const fps = cappedFps(asked, kind);
      // At display rate: just the next frame.
      if (fps >= 60) return invalidate();
      const at = performance.now() + 1000 / fps;
      if (at >= due) return;
      due = at;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(fire, at - performance.now());
    },
  };
  governors.set(invalidate, g);
  return g;
}

/** `want(fps, kind?)`: draw another frame within 1/fps s. Call it from `useFrame` while animating. */
export function useWantFrame(): (fps: number, kind?: FrameKind) => void {
  const invalidate = useThree((s) => s.invalidate);
  return governorFor(invalidate).want;
}

/** A frame after the canvas is resized (resizing clears it, and R3F asks for none). Once per Canvas. */
export function useFrameOnResize() {
  const invalidate = useThree((s) => s.invalidate);
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);
  useEffect(() => invalidate(), [invalidate, size, dpr]);
}

/** A handler with a fixed identity that always calls the latest `f` (see above). */
export function useStableHandler<A extends unknown[]>(f: (...args: A) => void): (...args: A) => void {
  const ref = useRef(f);
  useLayoutEffect(() => {
    ref.current = f;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}
