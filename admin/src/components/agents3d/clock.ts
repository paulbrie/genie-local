"use client";

/**
 * The 3D views' time cursor. Live: T is now. Replay: T advances at `speed`×
 * while playing, from wherever the scrubber put it. The scene reads `now()`
 * every frame it draws; React UI subscribes and gets ~4 updates a second
 * (none while the tab is hidden: a catch-up one when it shows again).
 */
export class Clock {
  live = true;
  playing = true;
  speed = 60;
  private t = Date.now();
  private lastReal = performance.now();
  private subs = new Set<() => void>();
  private pending = 0;
  /** Bumped on every notification; a stable snapshot for useSyncExternalStore. */
  tick = 0;
  /** Replay stops here (the newest data). */
  end = Date.now();

  now(): number {
    if (this.live) return Date.now();
    if (!this.playing) return this.t;
    return Math.min(this.t + (performance.now() - this.lastReal) * this.speed, this.end);
  }

  /** Folds the replay time played so far into `t`. */
  private advance() {
    const real = performance.now();
    if (!this.live && this.playing) {
      this.t = Math.min(this.t + (real - this.lastReal) * this.speed, this.end);
      if (this.t >= this.end) this.playing = false;
    }
    this.lastReal = real;
  }

  private notify() {
    this.tick++;
    for (const f of this.subs) f();
  }

  start() {
    // A timer, not a frame loop: nothing here needs 60 wake-ups a second.
    const iv = setInterval(() => {
      this.advance();
      if (document.visibilityState === "visible") this.notify();
    }, 250);
    const onShow = () => {
      if (document.visibilityState === "visible") this.notify();
    };
    document.addEventListener("visibilitychange", onShow);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onShow);
      cancelAnimationFrame(this.pending);
    };
  }

  subscribe = (f: () => void) => {
    this.subs.add(f);
    return () => {
      this.subs.delete(f);
    };
  };

  getTick = () => this.tick;

  /** Tell subscribers at the next frame (one notification for a burst of changes, e.g. a scrub). */
  private changed() {
    if (this.pending) return;
    this.pending = requestAnimationFrame(() => {
      this.pending = 0;
      this.notify();
    });
  }

  goLive() {
    this.advance();
    this.live = true;
    this.playing = true;
    this.changed();
  }

  seek(t: number) {
    this.advance();
    this.live = false;
    this.t = Math.min(t, this.end);
    this.changed();
  }

  setPlaying(p: boolean) {
    this.advance();
    if (this.live && !p) this.t = Date.now();
    if (this.live) this.live = false;
    this.playing = p;
    this.changed();
  }

  setEnd(t: number) {
    this.end = t;
  }

  setSpeed(s: number) {
    this.advance();
    this.speed = s;
    this.changed();
  }
}
