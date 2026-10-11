/**
 * One clock for every working Claude glyph on the page (T169): the CLI's spinner glyphs, there and back, a few
 * times a second, written straight into each glyph's element (no React render). One timer for all of them, running
 * only while a glyph is working and the tab shows. Cheaper than a CSS animation: that one asks the compositor for a
 * frame every refresh (120 a second on a ProMotion screen) while it runs, this one draws only when a glyph changes.
 * Framework-free, the timers passed in, so it can be checked.
 */

/** the CLI's "thinking" glyphs, from the bare dot to the full spark and back */
export const SPIN = ["·", "✢", "*", "✶", "✻", "✽", "✻", "✶", "*", "✢"] as const;
/** a frame's length (ms): 5 a second */
export const TICK_MS = 200;

type Env = {
  setInterval: (f: () => void, ms: number) => number;
  clearInterval: (id: number) => void;
  visible: () => boolean;
};

export function glyphTicker(env: Env) {
  const subs = new Map<number, { set: (g: string) => void; phase: number }>();
  let id: number | null = null, n = 0, next = 0;
  const tick = () => {
    n++;
    for (const s of subs.values()) s.set(SPIN[(n + s.phase) % SPIN.length]);
  };
  /** the timer runs only while someone works and the tab shows */
  const sync = () => {
    const want = subs.size > 0 && env.visible();
    if (want && id === null) id = env.setInterval(tick, TICK_MS);
    else if (!want && id !== null) {
      env.clearInterval(id);
      id = null;
    }
  };
  return {
    /** a working glyph: `set` gets each frame (its own phase, so they don't twinkle in step); the returned function stops it */
    add(set: (g: string) => void): () => void {
      const k = next++;
      subs.set(k, { set, phase: (k * 3) % SPIN.length });
      set(SPIN[(n + (k * 3)) % SPIN.length]);
      sync();
      return () => {
        subs.delete(k);
        sync();
      };
    },
    sync,
    running: () => id !== null,
  };
}
