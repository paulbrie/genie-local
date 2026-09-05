"use client";

import { Subject } from "subjecto";

/**
 * Settings for the spoken terminal alerts (see <TerminalVoiceMonitor>). Persisted
 * to localStorage so a browser remembers whether you want to be talked to.
 *
 * - `enabled`     — master on/off for the whole feature.
 * - `rate`        — utterance speed (0.5–2, 1 = normal).
 * - `engine`      — which synthesizer speaks:
 *     · "kokoro"  — the on-box neural voice (Kokoro-FastAPI via /api/tts). Natural,
 *                   consistent across machines, and — because it plays through Web
 *                   Audio — drives the orb with a REAL spectrum. Falls back to the
 *                   browser voice if the local service is unreachable.
 *     · "browser" — the OS Web Speech synthesizer (robotic, varies per machine).
 * - `kokoroVoice` — the chosen Kokoro voice id (e.g. "bm_george"); used when
 *                   `engine === "kokoro"`.
 * - `voiceURI`    — a specific installed browser voice, or null to let the browser
 *                   pick; used when `engine === "browser"`.
 * - `jarvis`      — "Jarvis mode": instead of the fixed "<name> finished" alerts,
 *                   an LLM (Claude, via the server's CLI) watches every terminal
 *                   and decides when to speak a natural, non-repetitive update.
 *                   Requires `enabled`. See <TerminalNarrator> and /api/narrate.
 */
export type VoiceEngine = "kokoro" | "browser";

export type VoiceSettings = {
  enabled: boolean;
  rate: number;
  engine: VoiceEngine;
  kokoroVoice: string;
  voiceURI: string | null;
  jarvis: boolean;
};

/**
 * Curated subset of the local Kokoro voices (the full model ships dozens plus
 * duplicate "v0" checkpoints). British male leads the list — the Jarvis vibe.
 * The id is what /api/tts forwards to Kokoro; the label is what the picker shows.
 */
export type KokoroVoice = { id: string; label: string };
export const KOKORO_VOICES: KokoroVoice[] = [
  { id: "bm_george", label: "George — British male" },
  { id: "bm_lewis", label: "Lewis — British male" },
  { id: "bm_daniel", label: "Daniel — British male" },
  { id: "bm_fable", label: "Fable — British male" },
  { id: "bf_emma", label: "Emma — British female" },
  { id: "bf_isabella", label: "Isabella — British female" },
  { id: "bf_alice", label: "Alice — British female" },
  { id: "bf_lily", label: "Lily — British female" },
  { id: "am_michael", label: "Michael — American male" },
  { id: "am_adam", label: "Adam — American male" },
  { id: "am_onyx", label: "Onyx — American male" },
  { id: "am_liam", label: "Liam — American male" },
  { id: "af_heart", label: "Heart — American female" },
  { id: "af_bella", label: "Bella — American female" },
  { id: "af_nicole", label: "Nicole — American female" },
  { id: "af_nova", label: "Nova — American female" },
  { id: "af_sarah", label: "Sarah — American female" },
  { id: "af_sky", label: "Sky — American female" },
];
export const DEFAULT_KOKORO_VOICE = "bm_george";
const KOKORO_IDS = new Set(KOKORO_VOICES.map((v) => v.id));

const KEY = "admin.terminals.voice";
const DEFAULTS: VoiceSettings = {
  enabled: false,
  rate: 1,
  engine: "kokoro",
  kokoroVoice: DEFAULT_KOKORO_VOICE,
  voiceURI: null,
  jarvis: false,
};

// Start from defaults for a stable first render; `hydrateVoice()` loads the saved
// choice after mount (mirrors the terminal dock's localStorage handling).
export const voice = new Subject<VoiceSettings>(DEFAULTS, {
  name: "terminalVoice",
});

function persist(s: VoiceSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode / no storage */
  }
}

/** Restore persisted settings. Call once, client-side, after mount. */
export function hydrateVoice() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    voice.next({
      enabled: !!s.enabled,
      rate:
        typeof s.rate === "number" ? Math.min(2, Math.max(0.5, s.rate)) : 1,
      // Legacy saves predate `engine`; default them to the new Kokoro voice.
      engine: s.engine === "browser" ? "browser" : "kokoro",
      kokoroVoice:
        typeof s.kokoroVoice === "string" && KOKORO_IDS.has(s.kokoroVoice)
          ? s.kokoroVoice
          : DEFAULT_KOKORO_VOICE,
      voiceURI: typeof s.voiceURI === "string" ? s.voiceURI : null,
      jarvis: !!s.jarvis,
    });
  } catch {
    /* ignore malformed state */
  }
}

/** Patch settings (persisted). */
export function setVoice(patch: Partial<VoiceSettings>) {
  const next = { ...voice.getValue(), ...patch };
  persist(next);
  voice.next(next);
}
