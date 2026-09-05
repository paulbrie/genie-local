"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Mic, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useSubject } from "subjecto/react";

import { BASE_PATH } from "@/lib/config";
import { say } from "@/lib/tts";
import { useSpeechInput } from "@/lib/use-speech-input";
import { setJarvis } from "@/store/jarvis";
import { voice } from "@/store/voice";

/**
 * Phase 2 of Jarvis: talk back to it. Hold-to-talk button → the spoken question
 * goes to /api/ask (which snapshots every terminal and answers via the Claude
 * CLI) → the answer is spoken aloud, and the <JarvisOrb> lights up throughout
 * (mic spectrum while you speak, synthetic while it replies).
 *
 * Mounted app-wide; only visible in Jarvis mode with speech support.
 */
export function JarvisConsole() {
  const [cfg] = useSubject(voice);
  const [phase, setPhase] = useState<"idle" | "listening" | "thinking">("idle");
  const [caption, setCaption] = useState("");
  const asking = useRef(false);

  const ask = useCallback(
    async (question: string) => {
      if (asking.current) return;
      asking.current = true;
      setJarvis({ listening: false, thinking: true });
      setPhase("thinking");
      setCaption(`“${question}”`);
      try {
        const res = await fetch(`${BASE_PATH}/api/ask`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question }),
        });
        const json: { answer?: string } = await res.json();
        const answer = json.answer?.trim() || "I didn't catch that.";
        setCaption(answer);
        // interrupt: this answer takes priority over any queued narration.
        say(answer, cfg, { interrupt: true });
      } catch {
        toast.error("Jarvis couldn't answer just now");
        setCaption("");
      } finally {
        setJarvis({ thinking: false });
        setPhase("idle");
        asking.current = false;
      }
    },
    [cfg],
  );

  const speech = useSpeechInput({
    // First finalized phrase becomes the question; answering stops the mic (below).
    onText: (text) => {
      const q = text.trim();
      if (q) void ask(q);
    },
    onError: (msg) => {
      toast.error(msg);
      setJarvis({ listening: false });
      setPhase("idle");
    },
  });

  // Stop the recognizer the moment we start thinking, so it doesn't keep firing
  // extra phrases or pick up Jarvis's own reply.
  useEffect(() => {
    if (phase === "thinking") speech.stop();
    // speech.stop is stable (useCallback); depend only on the phase transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  if (!cfg.enabled || !cfg.jarvis || !speech.supported) return null;

  const startTalk = () => {
    if (phase === "thinking") return;
    if (speech.listening) {
      speech.stop();
      setJarvis({ listening: false });
      setPhase("idle");
      return;
    }
    // The click is the user gesture that unlocks speech + audio in Chrome.
    setCaption("");
    setJarvis({ listening: true });
    setPhase("listening");
    speech.start();
  };

  const label =
    phase === "thinking"
      ? "Thinking…"
      : speech.listening
        ? speech.interim || "Listening…"
        : "Ask Jarvis";

  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[62] flex max-w-[70vw] flex-col items-end gap-2">
      {caption && (
        <div className="pointer-events-auto max-w-[22rem] rounded-2xl border bg-background/90 px-3 py-2 text-xs text-foreground shadow-lg ring-1 ring-foreground/10 backdrop-blur">
          {caption}
        </div>
      )}
      <button
        type="button"
        onClick={startTalk}
        disabled={phase === "thinking"}
        aria-label="Talk to Jarvis"
        title="Talk to Jarvis — ask about your terminals"
        className={`pointer-events-auto flex items-center gap-2 rounded-full border px-4 py-2.5 text-sm font-medium shadow-xl ring-1 backdrop-blur transition-colors ${
          speech.listening
            ? "border-cyan-400/60 bg-cyan-500/20 text-cyan-100 ring-cyan-400/40"
            : phase === "thinking"
              ? "border-foreground/20 bg-background/80 text-muted-foreground ring-foreground/10"
              : "border-foreground/15 bg-background/80 text-foreground ring-foreground/10 hover:bg-accent/60"
        }`}
      >
        {phase === "thinking" ? (
          <Loader2 className="size-4 animate-spin" />
        ) : speech.listening ? (
          <Mic className="size-4 animate-pulse" />
        ) : (
          <Sparkles className="size-4" />
        )}
        <span className="max-w-[16rem] truncate">{label}</span>
      </button>
    </div>
  );
}
