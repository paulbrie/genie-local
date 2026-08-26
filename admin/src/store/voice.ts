"use client";

import { Subject } from "subjecto";

/**
 * Settings for the spoken terminal alerts (see <TerminalVoiceMonitor>). Persisted
 * to localStorage so a browser remembers whether you want to be talked to.
 *
 * - `enabled`  — master on/off for the whole feature.
 * - `rate`     — utterance speed (0.5–2, 1 = normal).
 * - `voiceURI` — a specific installed voice, or null to let the browser pick.
 */
export type VoiceSettings = {
  enabled: boolean;
  rate: number;
  voiceURI: string | null;
};

const KEY = "admin.terminals.voice";
const DEFAULTS: VoiceSettings = { enabled: false, rate: 1, voiceURI: null };

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
      voiceURI: typeof s.voiceURI === "string" ? s.voiceURI : null,
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
