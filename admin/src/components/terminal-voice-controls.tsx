"use client";

import { useEffect, useState } from "react";
import { Sparkles, Volume2, VolumeX } from "lucide-react";
import { useSubject } from "subjecto/react";

import { Button } from "@/components/ui/button";
import { loadVoices, speechSupported } from "@/lib/speech";
import { say } from "@/lib/tts";
import { hydrateVoice, KOKORO_VOICES, setVoice, voice } from "@/store/voice";

/**
 * Settings for the spoken terminal alerts: master toggle, which voice to use (the
 * on-box neural "Jarvis" voices or the OS browser voices), how fast, and a Test
 * button. The actual announcing is done app-wide by <TerminalVoiceMonitor> /
 * <TerminalNarrator>; this only edits the shared `voice` settings.
 *
 * The voice dropdown encodes the engine in its value (`kokoro:<id>` /
 * `browser:<uri>`) so a single control picks both engine and voice.
 */
export function TerminalVoiceControls() {
  const [cfg] = useSubject(voice);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [hasBrowserVoices, setHasBrowserVoices] = useState(false);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    hydrateVoice();
    const webAudio =
      typeof window !== "undefined" &&
      !!(
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext
      );
    setHasBrowserVoices(speechSupported());
    // Kokoro needs only Web Audio; the browser voices need speechSynthesis.
    setSupported(webAudio || speechSupported());
    void loadVoices().then(setVoices);
  }, []);

  if (!supported) {
    return (
      <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
        This browser can’t play synthesized speech — voice needs Web Audio (any
        modern browser) or a Chromium-based browser’s speech synthesizer.
      </p>
    );
  }

  const toggle = () => {
    const next = !cfg.enabled;
    setVoice({ enabled: next });
    // This click is the user gesture that unlocks audio in Chrome; confirm out
    // loud so the first real alert isn't the one that gets silently blocked.
    if (next)
      say(cfg.jarvis ? "Jarvis online" : "Voice alerts on", cfg, {
        interrupt: true,
      });
  };

  const toggleJarvis = () => {
    const next = !cfg.jarvis;
    setVoice({ jarvis: next });
    // Speaking here doubles as the audio-unlock gesture.
    if (next && cfg.enabled) say("Jarvis online", cfg, { interrupt: true });
  };

  // Encode engine + voice in one select value; parse it back on change.
  const selectValue =
    cfg.engine === "kokoro"
      ? `kokoro:${cfg.kokoroVoice}`
      : `browser:${cfg.voiceURI ?? ""}`;

  const onVoiceChange = (v: string) => {
    if (v.startsWith("kokoro:")) {
      setVoice({ engine: "kokoro", kokoroVoice: v.slice("kokoro:".length) });
    } else {
      const uri = v.slice("browser:".length);
      setVoice({ engine: "browser", voiceURI: uri || null });
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border p-2">
      <Button
        type="button"
        size="sm"
        variant={cfg.enabled ? "default" : "outline"}
        className="h-7"
        onClick={toggle}
        title="Speak aloud when a terminal finishes or asks a question"
      >
        {cfg.enabled ? <Volume2 /> : <VolumeX />}
        {cfg.enabled ? "Voice alerts on" : "Voice alerts off"}
      </Button>

      <Button
        type="button"
        size="sm"
        variant={cfg.jarvis ? "default" : "outline"}
        className="h-7"
        onClick={toggleJarvis}
        disabled={!cfg.enabled}
        title="Jarvis mode: an LLM watches every terminal and narrates progress in natural language, instead of fixed alerts"
      >
        <Sparkles />
        {cfg.jarvis ? "Jarvis on" : "Jarvis"}
      </Button>

      <select
        aria-label="Alert voice"
        title="Voice used for terminal alerts"
        value={selectValue}
        onChange={(e) => onVoiceChange(e.target.value)}
        disabled={!cfg.enabled}
        className="h-7 max-w-[14rem] rounded-md border bg-background px-1 text-xs text-foreground disabled:opacity-50"
      >
        <optgroup label="Jarvis voice — on-box, natural">
          {KOKORO_VOICES.map((v) => (
            <option key={v.id} value={`kokoro:${v.id}`}>
              {v.label}
            </option>
          ))}
        </optgroup>
        {hasBrowserVoices && (
          <optgroup label="Browser voices — robotic">
            <option value="browser:">Automatic voice</option>
            {voices.map((v) => (
              <option key={v.voiceURI} value={`browser:${v.voiceURI}`}>
                {v.name} ({v.lang})
              </option>
            ))}
          </optgroup>
        )}
      </select>

      <label className="flex items-center gap-1 text-xs text-muted-foreground">
        Speed
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.25}
          value={cfg.rate}
          onChange={(e) => setVoice({ rate: Number(e.target.value) })}
          disabled={!cfg.enabled}
          className="w-20"
        />
      </label>

      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7"
        disabled={!cfg.enabled}
        onClick={() => say("Terminal finished", cfg, { interrupt: true })}
      >
        Test
      </Button>
    </div>
  );
}
