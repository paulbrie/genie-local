"use client";

/**
 * The 3D views' time cursor. Live: T is now. Replay: T advances at `speed`×
 * while playing, from wherever the scrubber put it. The scene reads `now()`
 * every frame; React UI subscribes and gets ~4 updates a second.
 */
export class Clock {
  live = true;
  playing = true;
  speed = 60;
  private t = Date.now();
  private lastReal = performance.now();
  private subs = new Set<() => void>();
  private lastNotify = 0;
  private raf = 0;
  /** Bumped on every notification; a stable snapshot for useSyncExternalStore. */
  tick = 0;
  /** Replay stops here (the newest data). */
  end = Date.now();

  now(): number {
    return this.live ? Date.now() : this.t;
  }

  start() {
    const tick = () => {
      const real = performance.now();
      const dt = real - this.lastReal;
      this.lastReal = real;
      if (!this.live && this.playing) {
        this.t = Math.min(this.t + dt * this.speed, this.end);
        if (this.t >= this.end) this.playing = false;
      }
      if (real - this.lastNotify > 250) {
        this.lastNotify = real;
        this.tick++;
        for (const f of this.subs) f();
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(this.raf);
  }

  subscribe = (f: () => void) => {
    this.subs.add(f);
    return () => {
      this.subs.delete(f);
    };
  };

  getTick = () => this.tick;

  private changed() {
    this.lastNotify = 0;
  }

  goLive() {
    this.live = true;
    this.playing = true;
    this.changed();
  }

  seek(t: number) {
    this.live = false;
    this.t = Math.min(t, this.end);
    this.changed();
  }

  setPlaying(p: boolean) {
    if (this.live && !p) this.t = Date.now();
    if (this.live) this.live = false;
    this.playing = p;
    this.changed();
  }

  setEnd(t: number) {
    this.end = t;
  }

  setSpeed(s: number) {
    this.speed = s;
    this.changed();
  }
}
