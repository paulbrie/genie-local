/**
 * Browser text-to-speech helpers (Web Speech API `speechSynthesis`). Client-only
 * — every function guards on `window`, so importing from a shared module is safe,
 * but the actual speaking only happens in the browser (Chrome/Chromium ship the
 * synthesizer; a headless/serverless context has no voices and stays silent).
 */

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/**
 * The installed TTS voices. Chrome populates this list ASYNCHRONOUSLY, so if it's
 * not ready yet we wait for `voiceschanged` — with a short timeout so callers
 * never hang when no voices exist at all.
 */
export function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!speechSupported()) return Promise.resolve([]);
  const synth = window.speechSynthesis;
  const ready = synth.getVoices();
  if (ready.length) return Promise.resolve(ready);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      synth.removeEventListener("voiceschanged", finish);
      resolve(synth.getVoices());
    };
    synth.addEventListener("voiceschanged", finish);
    // Fallback: some platforms never fire the event when the list is empty.
    setTimeout(finish, 1000);
  });
}

/** Speak a phrase. No-op when unsupported or empty. */
export function speak(
  text: string,
  opts: { rate?: number; voiceURI?: string | null; interrupt?: boolean } = {},
): void {
  if (!speechSupported() || !text) return;
  const synth = window.speechSynthesis;
  // `interrupt` clears any queued/among-utterance speech first (used by "Test");
  // alerts otherwise queue naturally so two terminals don't talk over each other.
  if (opts.interrupt) synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (opts.rate) u.rate = opts.rate;
  if (opts.voiceURI) {
    const v = synth.getVoices().find((x) => x.voiceURI === opts.voiceURI);
    if (v) u.voice = v;
  }
  synth.speak(u);
}
