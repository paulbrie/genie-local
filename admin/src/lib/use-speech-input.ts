"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Voice dictation via the browser's Web Speech API (Chrome exposes it as
 * `webkitSpeechRecognition`; it isn't in the standard TS DOM lib, hence the
 * minimal typings below). Used to "talk" text into a terminal: each finalized
 * phrase is handed to `onText`, which the caller forwards to tmux.
 *
 * Only Chromium-based browsers ship this today — callers should gate the mic UI
 * on `supported`.
 */

interface SpeechAlternative {
  transcript: string;
}
interface SpeechResult {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechAlternative;
}
interface SpeechResultList {
  length: number;
  [index: number]: SpeechResult;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechResultList;
}
interface SpeechErrorEventLike {
  error: string;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechErrorEventLike) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** A curated set of BCP-47 language tags offered in the voice-input picker. */
export const SPEECH_LANGS: { value: string; label: string }[] = [
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "ro-RO", label: "Română" },
  { value: "fr-FR", label: "Français" },
  { value: "de-DE", label: "Deutsch" },
  { value: "es-ES", label: "Español (ES)" },
  { value: "es-MX", label: "Español (MX)" },
  { value: "it-IT", label: "Italiano" },
  { value: "pt-BR", label: "Português (BR)" },
  { value: "pt-PT", label: "Português (PT)" },
  { value: "nl-NL", label: "Nederlands" },
  { value: "pl-PL", label: "Polski" },
  { value: "ru-RU", label: "Русский" },
  { value: "uk-UA", label: "Українська" },
  { value: "ja-JP", label: "日本語" },
  { value: "ko-KR", label: "한국어" },
  { value: "zh-CN", label: "中文 (简体)" },
  { value: "zh-TW", label: "中文 (繁體)" },
  { value: "hi-IN", label: "हिन्दी" },
  { value: "ar-SA", label: "العربية" },
];

const LANG_KEY = "admin-term-speech-lang";

function loadLang(): string | null {
  try {
    return localStorage.getItem(LANG_KEY);
  } catch {
    return null;
  }
}
function saveLang(lang: string) {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    /* private mode / no storage */
  }
}

export type SpeechInput = {
  /** Whether this browser exposes the Web Speech API at all. */
  supported: boolean;
  /** True while the mic is actively listening. */
  listening: boolean;
  /** The BCP-47 language tag being recognized (e.g. "en-US"). */
  lang: string;
  /** Change the recognition language (persisted; restarts if mid-session). */
  setLang: (lang: string) => void;
  /** Live, not-yet-finalized transcript (for an on-screen "…heard so far" hint). */
  interim: string;
  start: () => void;
  stop: () => void;
  toggle: () => void;
};

export function useSpeechInput({
  onText,
  onError,
}: {
  /** Called once per finalized phrase, in order. */
  onText: (text: string) => void;
  onError?: (message: string) => void;
}): SpeechInput {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [lang, setLangState] = useState("");
  const [interim, setInterim] = useState("");
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  // Mirror the language in a ref so the recognizer (created outside render) and
  // the auto-restart path always read the current value, not a stale closure.
  const langRef = useRef("");
  // `want` tracks the user's intent independently of the engine: Chrome stops on
  // silence and fires `onend`, and we restart while the user still wants to talk.
  const want = useRef(false);

  // Keep the latest callbacks without re-creating the recognizer each render.
  const onTextRef = useRef(onText);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onTextRef.current = onText;
    onErrorRef.current = onError;
  }, [onText, onError]);

  useEffect(() => {
    setSupported(getCtor() !== null);
    // Persisted choice wins; otherwise fall back to the browser's locale.
    const initial = loadLang() || navigator.language || "en-US";
    langRef.current = initial;
    setLangState(initial);
  }, []);

  const stop = useCallback(() => {
    want.current = false;
    setListening(false);
    setInterim("");
    recRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    if (recRef.current) return; // already running
    const Ctor = getCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = langRef.current || navigator.language || "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    if (process.env.NODE_ENV !== "production")
      console.debug("[speech] start", { lang: rec.lang });

    rec.onresult = (e) => {
      let live = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0]?.transcript ?? "";
        if (r.isFinal) onTextRef.current(text);
        else live += text;
      }
      if (process.env.NODE_ENV !== "production")
        console.debug("[speech] result", { interim: live });
      setInterim(live);
    };
    rec.onerror = (e) => {
      if (process.env.NODE_ENV !== "production")
        console.debug("[speech] error", e.error);
      switch (e.error) {
        // Routine between phrases — leave the session running so `onend` restarts.
        case "no-speech":
        case "aborted":
          return;
        // Fatal for this session — stop and tell the user what went wrong.
        case "not-allowed":
        case "service-not-allowed":
          want.current = false;
          onErrorRef.current?.(
            "Microphone access is blocked — allow it to use voice input",
          );
          return;
        case "audio-capture":
          want.current = false;
          onErrorRef.current?.("No microphone found — check your input device");
          return;
        case "network":
          want.current = false;
          onErrorRef.current?.(
            "Voice recognition can't reach the network service — check your connection",
          );
          return;
        case "language-not-supported":
          want.current = false;
          onErrorRef.current?.(
            `Voice input isn't available for language "${rec.lang}"`,
          );
          return;
        default:
          want.current = false;
          onErrorRef.current?.(`Voice input failed (${e.error})`);
      }
    };
    rec.onend = () => {
      setInterim("");
      // Restart if the user hasn't toggled off; otherwise tear down. Re-apply the
      // current language so a switch made mid-session takes effect on restart.
      if (want.current) {
        try {
          rec.lang = langRef.current || rec.lang;
          rec.start();
          return;
        } catch {
          /* fall through to teardown */
        }
      }
      recRef.current = null;
      setListening(false);
    };

    want.current = true;
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      recRef.current = null;
      want.current = false;
      onErrorRef.current?.("Could not start voice input");
    }
  }, []);

  const toggle = useCallback(() => {
    if (want.current) stop();
    else start();
  }, [start, stop]);

  const setLang = useCallback((next: string) => {
    if (!next || next === langRef.current) return;
    langRef.current = next;
    setLangState(next);
    saveLang(next);
    // If mid-session, bounce the recognizer so the new language applies now —
    // `onend`'s restart path re-reads `langRef` and comes back up in `next`.
    if (want.current) recRef.current?.stop();
  }, []);

  // Stop listening if the component unmounts (window closed).
  useEffect(() => {
    return () => {
      want.current = false;
      recRef.current?.abort();
      recRef.current = null;
    };
  }, []);

  return { supported, listening, lang, setLang, interim, start, stop, toggle };
}
