"use client";

import { Subject } from "subjecto";

/**
 * Ephemeral runtime state for the Jarvis presence (the reactive dust-cloud orb
 * and the conversational console). NOT persisted.
 *
 * - `listening` — the mic is open capturing a spoken question (real audio spectrum
 *   drives the orb).
 * - `thinking`  — a /api/ask request is in flight (orb shows a calm "processing"
 *   state until the answer is spoken).
 *
 * "Speaking" is not tracked here — the orb reads `speechSynthesis.speaking`
 * directly, so it lights up for BOTH narration and answers with no extra wiring.
 */
export type JarvisState = { listening: boolean; thinking: boolean };

export const jarvis = new Subject<JarvisState>(
  { listening: false, thinking: false },
  { name: "jarvis" },
);

export function setJarvis(patch: Partial<JarvisState>) {
  jarvis.next({ ...jarvis.getValue(), ...patch });
}
