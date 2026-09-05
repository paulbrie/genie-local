"use client";

import { useEffect, useRef } from "react";
import { useSubject } from "subjecto/react";

import { reactor } from "@/lib/jarvis-audio";
import { isSpeaking as ttsSpeaking } from "@/lib/tts";
import { jarvis } from "@/store/jarvis";
import { hydrateVoice, voice } from "@/store/voice";

/**
 * The Jarvis presence: a rotating 3D cloud of glowing dust that reacts to the
 * live sound spectrum. Pure Canvas 2D with a hand-rolled perspective projection
 * (no WebGL/three.js dependency).
 *
 * Each particle sits on a sphere and is pushed OUTWARD by the energy of its
 * mapped frequency band, so the cloud blooms and spikes with the spectrum; peaks
 * flare toward white. The whole thing spins continuously, pulses with the overall
 * level, and fades in only while Jarvis is listening, thinking, or speaking — so
 * it "materialises" when Jarvis is present and dissolves when it's idle.
 *
 * Only mounted/active in Jarvis mode (voice enabled + jarvis on).
 */

const PARTICLES = 1300;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

type P = { x: number; y: number; z: number; band: number; jitter: number };

/** Even coverage via a Fibonacci sphere; latitude maps to a frequency band. */
function makeParticles(n: number, bands: number): P[] {
  const out: P[] = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2; // 1 → -1
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = i * GOLDEN_ANGLE;
    const band = Math.min(
      bands - 1,
      Math.max(0, Math.floor(((y + 1) / 2) * bands)),
    );
    out.push({
      x: Math.cos(theta) * r,
      y,
      z: Math.sin(theta) * r,
      band,
      jitter: 0.85 + (i % 7) * 0.045, // slight per-particle radius variety
    });
  }
  return out;
}

/** A soft radial "dust mote" sprite in a given colour, pre-rendered once. */
function makeSprite(color: string, size = 32): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  grad.addColorStop(0, color);
  grad.addColorStop(0.5, color.replace("1)", "0.35)"));
  grad.addColorStop(1, color.replace("1)", "0)"));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

// Deep-blue → cyan → white; index by band energy so louder = hotter/whiter.
const PALETTE = [
  "hsla(224,90%,62%,1)",
  "hsla(214,95%,64%,1)",
  "hsla(202,96%,66%,1)",
  "hsla(190,95%,66%,1)",
  "hsla(184,92%,72%,1)",
  "hsla(178,90%,80%,1)",
  "hsla(180,70%,90%,1)",
  "hsla(190,60%,98%,1)",
];

export function JarvisOrb() {
  const [{ enabled, jarvis: jarvisOn }] = useSubject(voice);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    hydrateVoice();
  }, []);

  useEffect(() => {
    if (!enabled || !jarvisOn) return;
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const particles = makeParticles(PARTICLES, reactor.bands);
    const sprites = PALETTE.map((c) => makeSprite(c));
    const spectrum = new Float32Array(reactor.bands);

    let dpr = 1;
    let w = 0;
    let h = 0;
    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      const rect = wrap.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    let raf = 0;
    let yaw = 0;
    let opacity = 0;
    let micOn = false;
    let micPending = false;
    const start = performance.now();

    const frame = (nowTs: number) => {
      const t = nowTs - start;
      const st = jarvis.getValue();
      const speaking =
        ttsSpeaking() ||
        (typeof window !== "undefined" && "speechSynthesis" in window
          ? window.speechSynthesis.speaking
          : false);

      // Manage the mic exactly while listening (real spectrum).
      if (st.listening && !micOn && !micPending) {
        micPending = true;
        void reactor.attachMic().then((ok) => {
          micOn = ok;
          micPending = false;
        });
      } else if (!st.listening && micOn) {
        micOn = false;
        reactor.detachMic();
      }

      const level = reactor.sample(spectrum, {
        speaking,
        listening: st.listening,
        t,
      });

      // Fade the whole presence in/out based on activity.
      const active = speaking || st.listening || st.thinking || level > 0.06;
      opacity += ((active ? 1 : 0) - opacity) * 0.08;
      wrap.style.opacity = opacity.toFixed(3);
      if (opacity < 0.004) {
        raf = requestAnimationFrame(frame);
        return;
      }

      // Spin faster with energy; gently tilt.
      yaw += 0.0016 + level * 0.006;
      const pitch = Math.sin(t * 0.0004) * 0.35 + 0.32;
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      const cx = Math.cos(pitch);
      const sx = Math.sin(pitch);

      const cW = canvas.width;
      const cH = canvas.height;
      const R = Math.min(cW, cH) * 0.3;
      const ox = cW / 2;
      const oy = cH / 2;
      const focal = 3.4;
      const breathe = 1 + Math.sin(t * 0.0011) * 0.02;

      ctx.clearRect(0, 0, cW, cH);
      ctx.globalCompositeOperation = "lighter";

      // Core glow — a soft cyan heart that swells with the level.
      const coreR = R * (0.35 + level * 0.55);
      const core = ctx.createRadialGradient(ox, oy, 0, ox, oy, coreR);
      core.addColorStop(0, `hsla(188,95%,72%,${0.12 + level * 0.35})`);
      core.addColorStop(1, "hsla(200,90%,60%,0)");
      ctx.fillStyle = core;
      ctx.fillRect(0, 0, cW, cH);

      for (const p of particles) {
        const e = spectrum[p.band]; // 0..1 band energy
        // Bloom outward with the band energy + a whole-cloud breathe/pulse.
        const rad = (1 + e * 0.95 + level * 0.12) * p.jitter * breathe;
        let X = p.x * rad;
        let Y = p.y * rad;
        let Z = p.z * rad;

        // Rotate: yaw about Y, then pitch about X.
        const x1 = X * cy - Z * sy;
        const z1 = X * sy + Z * cy;
        X = x1;
        Z = z1;
        const y1 = Y * cx - Z * sx;
        const z2 = Y * sx + Z * cx;
        Y = y1;
        Z = z2;

        // Perspective project.
        const scale = focal / (focal - Z);
        const sxp = ox + X * scale * R;
        const syp = oy - Y * scale * R;

        // Depth + energy drive size, brightness, and colour (peaks flare white).
        const depth = (scale - focal / (focal + 1.2)) * 1.4;
        const bright = Math.min(1, 0.18 + e * 1.05 + depth * 0.25);
        const size = (1.1 + e * 4.2 + depth * 1.6) * dpr;
        const hueIdx = Math.min(
          sprites.length - 1,
          Math.floor(Math.min(1, e * 1.25 + depth * 0.15) * (sprites.length - 1)),
        );

        ctx.globalAlpha = bright * (0.5 + depth * 0.5);
        ctx.drawImage(
          sprites[hueIdx],
          sxp - size,
          syp - size,
          size * 2,
          size * 2,
        );
      }
      ctx.globalAlpha = 1;

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      if (micOn) reactor.detachMic();
    };
  }, [enabled, jarvisOn]);

  if (!enabled || !jarvisOn) return null;

  return (
    <div
      ref={wrapRef}
      aria-hidden
      className="pointer-events-none fixed left-1/2 top-1/2 z-[80] size-[min(70vw,70vh,560px)] -translate-x-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-300"
    >
      <canvas ref={canvasRef} className="size-full" />
    </div>
  );
}
