"use client";

import { BASE_PATH } from "@/lib/config";
import { reactor } from "@/lib/jarvis-audio";
import { speak as browserSpeak } from "@/lib/speech";
import type { VoiceSettings } from "@/store/voice";

/**
 * Playback layer for spoken output. One entry point — `say()` — used by every
 * caller (alerts, the Jarvis narrator, Q&A answers, the settings Test button).
 *
 * Two engines behind it:
 *  - "kokoro"  → POST /api/tts (on-box neural voice), decoded and played through a
 *    single shared Web Audio graph: source → AnalyserNode → destination. Routing
 *    through the analyser means the Jarvis orb can read a REAL spectrum while it
 *    talks (see jarvis-audio's speaking branch), instead of a synthetic fake. If a
 *    request fails (service down), that utterance falls back to the browser voice.
 *  - "browser" → the OS Web Speech synthesizer (src/lib/speech.ts).
 *
 * A tiny FIFO serializes Kokoro utterances: only one is fetched+played at a time,
 * so several terminals are heard in turn (never overlapping) and the CPU-bound
 * synthesizer isn't hit by a burst. `interrupt` clears the queue and cuts the
 * current clip — used by the Q&A answer and the Test button.
 */

type Job = { text: string; voice: string; speed: number };

let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let current: AudioBufferSourceNode | null = null;
const queue: Job[] = [];
let draining = false;
let speaking = false;

/** True while a Kokoro clip is playing (the orb ORs this with speechSynthesis). */
export function isSpeaking(): boolean {
  return speaking;
}

function canWebAudio(): boolean {
  return (
    typeof window !== "undefined" &&
    !!(
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext
    )
  );
}

/** Lazily build the shared graph and hand the analyser to the orb's reactor. */
function ensureGraph(): AudioContext | null {
  if (ctx) return ctx;
  if (!canWebAudio()) return null;
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  ctx = new Ctx();
  analyser = ctx.createAnalyser();
  analyser.fftSize = 256; // 128 bins — matches the mic analyser
  analyser.smoothingTimeConstant = 0.72;
  analyser.connect(ctx.destination);
  // The orb reads this analyser for a real spectrum while Jarvis speaks.
  reactor.setSpeakingSource(analyser);
  return ctx;
}

/** Fetch + decode one utterance. Returns null if the service is unreachable. */
async function synth(job: Job, c: AudioContext): Promise<AudioBuffer | null> {
  try {
    const res = await fetch(`${BASE_PATH}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: job.text,
        voice: job.voice,
        speed: job.speed,
      }),
    });
    if (!res.ok) return null;
    const bytes = await res.arrayBuffer();
    // decodeAudioData may detach the buffer, so hand it a copy.
    return await c.decodeAudioData(bytes.slice(0));
  } catch {
    return null;
  }
}

function playBuffer(buf: AudioBuffer, c: AudioContext): Promise<void> {
  return new Promise((resolve) => {
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(analyser!);
    current = src;
    src.onended = () => {
      if (current === src) current = null;
      resolve();
    };
    src.start();
  });
}

async function drain() {
  if (draining) return;
  const c = ensureGraph();
  if (!c) return;
  draining = true;
  // A gesture-suspended context (autoplay policy) resumes here — say() is called
  // from the toggle/Test click, which counts as the unlocking gesture.
  await c.resume().catch(() => {});
  try {
    while (queue.length) {
      const job = queue.shift()!;
      const buf = await synth(job, c);
      if (buf) {
        speaking = true;
        await playBuffer(buf, c);
      } else {
        // Service down → don't drop the line; speak it with the browser voice.
        browserSpeak(job.text, { rate: job.speed });
      }
    }
  } finally {
    speaking = false;
    draining = false;
  }
}

/** Stop playback and clear anything queued. */
export function stopSpeaking() {
  queue.length = 0;
  try {
    current?.stop();
  } catch {
    /* already stopped */
  }
  current = null;
  speaking = false;
}

/**
 * Speak `text` using the engine chosen in settings. Non-blocking. `interrupt`
 * clears the queue and cuts the current clip first (answers/Test take priority);
 * otherwise utterances queue so terminals are heard one after another.
 */
export function say(
  text: string,
  cfg: VoiceSettings,
  opts: { interrupt?: boolean } = {},
): void {
  const t = text?.trim();
  if (!t) return;

  if (cfg.engine === "kokoro" && canWebAudio()) {
    if (opts.interrupt) stopSpeaking();
    queue.push({ text: t, voice: cfg.kokoroVoice, speed: cfg.rate });
    void drain();
    return;
  }

  // Browser engine (or no Web Audio at all).
  browserSpeak(t, {
    rate: cfg.rate,
    voiceURI: cfg.voiceURI,
    interrupt: opts.interrupt,
  });
}
