"use client";

import { useEffect, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { useSubject } from "subjecto/react";

import { Button } from "@/components/ui/button";
import { loadVoices, speak, speechSupported } from "@/lib/speech";
import { hydrateVoice, setVoice, voice } from "@/store/voice";

/**
 * Settings for the spoken terminal alerts: master toggle, which installed voice
 * to use, how fast, and a Test button. The actual announcing is done app-wide by
 * <TerminalVoiceMonitor>; this only edits the shared `voice` settings.
 */
export function TerminalVoiceControls() {
  const [cfg] = useSubject(voice);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    hydrateVoice();
    setSupported(speechSupported());
    void loadVoices().then(setVoices);
  }, []);

  if (!supported) {
    return (
      <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
        This browser has no speech synthesizer — spoken alerts need Chrome or
        another Chromium-based browser.
      </p>
    );
  }

  const toggle = () => {
    const next = !cfg.enabled;
    setVoice({ enabled: next });
    // This click is the user gesture that unlocks speech in Chrome; confirm out
    // loud so the first real alert isn't the one that gets silently blocked.
    if (next)
      speak("Voice alerts on", {
        rate: cfg.rate,
        voiceURI: cfg.voiceURI,
        interrupt: true,
      });
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

      <select
        aria-label="Alert voice"
        title="Voice used for terminal alerts"
        value={cfg.voiceURI ?? ""}
        onChange={(e) => setVoice({ voiceURI: e.target.value || null })}
        disabled={!cfg.enabled}
        className="h-7 max-w-[12rem] rounded-md border bg-background px-1 text-xs text-foreground disabled:opacity-50"
      >
        <option value="">Automatic voice</option>
        {voices.map((v) => (
          <option key={v.voiceURI} value={v.voiceURI}>
            {v.name} ({v.lang})
          </option>
        ))}
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
        onClick={() =>
          speak("Terminal finished", {
            rate: cfg.rate,
            voiceURI: cfg.voiceURI,
            interrupt: true,
          })
        }
      >
        Test
      </Button>
    </div>
  );
}
