"use client";

/**
 * Audio → spectrum engine for the Jarvis orb.
 *
 * Three sources feed the same smoothed band array:
 *  - LISTENING: a real mic stream through a Web Audio AnalyserNode (true FFT).
 *  - SPEAKING:  a real FFT when the neural (Kokoro) voice is playing — its Web
 *    Audio graph hands us its AnalyserNode via `setSpeakingSource`. When that's
 *    absent (the browser Web Speech voice, whose output browsers WON'T route into
 *    an AnalyserNode), we fall back to a SYNTHETIC, formant-shaped spectrum so the
 *    cloud still comes alive.
 *  - IDLE: nothing → the bands decay toward zero (gentle breathing).
 *
 * The engine keeps a smoothed internal buffer (fast attack, slow release) so the
 * motion looks organic regardless of source. One shared singleton (`reactor`).
 */
export class AudioReactor {
  private ctx?: AudioContext;
  private analyser?: AnalyserNode;
  private stream?: MediaStream;
  private freq?: Uint8Array<ArrayBuffer>;
  private speakAnalyser?: AnalyserNode;
  private speakFreq?: Uint8Array<ArrayBuffer>;
  private readonly smooth: Float32Array;
  private readonly target: Float32Array;

  constructor(public readonly bands = 56) {
    this.smooth = new Float32Array(bands);
    this.target = new Float32Array(bands);
  }

  /**
   * Register (or clear) the AnalyserNode the neural voice plays through, so the
   * SPEAKING branch can read a real spectrum instead of the synthetic fallback.
   * Called by src/lib/tts.ts when it builds its Web Audio graph.
   */
  setSpeakingSource(analyser: AnalyserNode | null) {
    this.speakAnalyser = analyser ?? undefined;
    this.speakFreq = analyser
      ? new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount))
      : undefined;
  }

  /** Open the mic and wire up analysis. Idempotent; resolves false if denied. */
  async attachMic(): Promise<boolean> {
    if (this.analyser) return true;
    if (typeof navigator === "undefined" || !navigator.mediaDevices) return false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctx();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256; // 128 bins
      analyser.smoothingTimeConstant = 0.72;
      src.connect(analyser);
      this.ctx = ctx;
      this.analyser = analyser;
      this.stream = stream;
      this.freq = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
      return true;
    } catch {
      return false;
    }
  }

  detachMic() {
    this.stream?.getTracks().forEach((t) => t.stop());
    try {
      this.analyser?.disconnect();
      void this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.ctx = undefined;
    this.analyser = undefined;
    this.stream = undefined;
    this.freq = undefined;
  }

  /**
   * Bin an AnalyserNode's byte spectrum into `bands` targets (0..1). Voice energy
   * sits low in the range, so only the bottom ~70% of bins is spread across.
   */
  private readAnalyser(
    analyser: AnalyserNode,
    freq: Uint8Array<ArrayBuffer>,
    tg: Float32Array,
  ) {
    analyser.getByteFrequencyData(freq);
    const n = this.bands;
    const bins = freq.length;
    const usable = Math.floor(bins * 0.7);
    for (let i = 0; i < n; i++) {
      const a = Math.floor((i / n) * usable);
      const b = Math.floor(((i + 1) / n) * usable);
      let s = 0;
      let c = 0;
      for (let k = a; k <= b && k < bins; k++) {
        s += freq[k];
        c++;
      }
      tg[i] = c ? s / c / 255 : 0;
    }
  }

  /**
   * Advance one frame. Fills `out` (length = `bands`) with 0..1 energies and
   * returns the overall level (0..1). `t` is a monotonic ms clock for animation.
   */
  sample(
    out: Float32Array,
    opts: { speaking: boolean; listening: boolean; t: number },
  ): number {
    const n = this.bands;
    const tg = this.target;

    if (opts.listening && this.analyser && this.freq) {
      this.readAnalyser(this.analyser, this.freq, tg);
    } else if (opts.speaking && this.speakAnalyser && this.speakFreq) {
      // Real FFT of the neural voice currently playing (routed through tts.ts).
      this.readAnalyser(this.speakAnalyser, this.speakFreq, tg);
    } else if (opts.speaking) {
      // Synthetic speaking spectrum: two formant bumps + a slow envelope + fast
      // per-band flicker → reads as a voice without any real audio to analyse.
      const env = 0.55 + 0.45 * Math.abs(Math.sin(opts.t * 0.006));
      for (let i = 0; i < n; i++) {
        const f = i / n;
        const formants =
          Math.exp(-Math.pow((f - 0.13) / 0.1, 2)) +
          0.7 * Math.exp(-Math.pow((f - 0.38) / 0.16, 2));
        const flick =
          0.5 +
          0.5 *
            Math.sin(opts.t * 0.02 + i * 0.7) *
            Math.sin(opts.t * 0.013 + i * 0.31);
        tg[i] = Math.min(1, formants * env * (0.45 + 0.75 * flick));
      }
    } else {
      for (let i = 0; i < n; i++) tg[i] = 0; // idle → decay
    }

    // Smooth toward the target: snap up on attack, ease down on release.
    let level = 0;
    for (let i = 0; i < n; i++) {
      const cur = this.smooth[i];
      const k = tg[i] > cur ? 0.5 : 0.08;
      const v = cur + (tg[i] - cur) * k;
      this.smooth[i] = v;
      out[i] = v;
      level += v;
    }
    return Math.min(1, (level / n) * 1.7);
  }
}

export const reactor = new AudioReactor(56);
