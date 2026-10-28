"use client";

import { Mic } from "lucide-react";
import { type CSSProperties, type RefObject, useEffect, useRef } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { SPEECH_LANGS, type SpeechInput, useSpeechInput } from "@/lib/use-speech-input";
import { cn } from "@/lib/utils";

/**
 * The voice-input language picker (shared by the terminal windows and the
 * dictation controls). Keeps an unlisted browser/persisted locale selectable.
 */
export function SpeechLangSelect({
  speech,
  className,
  style,
}: {
  speech: SpeechInput;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <select
      aria-label="Voice input language"
      title="Voice input language"
      value={speech.lang}
      onChange={(e) => speech.setLang(e.target.value)}
      style={style}
      className={className}
    >
      {!SPEECH_LANGS.some((l) => l.value === speech.lang) && speech.lang && (
        <option value={speech.lang}>{speech.lang}</option>
      )}
      {SPEECH_LANGS.map((l) => (
        <option key={l.value} value={l.value}>
          {l.label}
        </option>
      ))}
    </select>
  );
}

type Field = HTMLInputElement | HTMLTextAreaElement;

const isField = (el: unknown): el is Field =>
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLInputElement && ["text", "search", ""].includes(el.type));

/**
 * Type `text` into a field at its cursor (replacing any selection), spaced off
 * the word before it. Goes through `setRangeText` + an `input` event, so React's
 * onChange fires for controlled fields and uncontrolled ones just keep the text.
 */
function insertAtCursor(el: Field, text: string) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const before = el.value.slice(0, start);
  let chunk = text.trim();
  if (!chunk) return;
  if (before && !/\s$/.test(before)) chunk = " " + chunk;
  if (el.maxLength > 0) chunk = chunk.slice(0, Math.max(0, el.maxLength - (el.value.length - (end - start))));
  if (!chunk) return;
  el.setRangeText(chunk, start, end, "end");
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Voice dictation for a form, the same Web Speech input the terminal windows
 * have: a language picker and a mic button. Each finalized phrase goes in at the
 * cursor of the text field inside `scope` that has (or last had) focus, the
 * first one if none has yet. Renders nothing in browsers without the API.
 */
export function DictationControls({
  scope,
  className,
}: {
  scope: RefObject<HTMLElement | null>;
  className?: string;
}) {
  const target = useRef<Field | null>(null);

  // Remember the last text field focused in the form: clicking the mic button
  // (or the language picker) moves focus away from it.
  useEffect(() => {
    const root = scope.current;
    if (!root) return;
    const onFocusIn = (e: FocusEvent) => {
      if (isField(e.target)) target.current = e.target;
    };
    root.addEventListener("focusin", onFocusIn);
    return () => root.removeEventListener("focusin", onFocusIn);
  }, [scope]);

  const field = () => {
    const root = scope.current;
    if (!root) return null;
    const active = document.activeElement;
    if (isField(active) && root.contains(active)) return active;
    if (target.current && root.contains(target.current)) return target.current;
    return [...root.querySelectorAll("input, textarea")].find(isField) ?? null;
  };

  const speech = useSpeechInput({
    onText: (text) => {
      const el = field();
      if (el) insertAtCursor(el, text);
    },
    onError: (msg) => toast.error(msg),
  });

  if (!speech.supported) return null;
  return (
    <span className={cn("flex items-center gap-1", className)}>
      {speech.listening && speech.interim && (
        <span className="max-w-[14rem] truncate text-xs italic text-muted-foreground" title={speech.interim}>
          “{speech.interim}”
        </span>
      )}
      <SpeechLangSelect speech={speech} className="h-7 rounded-md border bg-background px-1 text-xs text-foreground" />
      <Button
        type="button"
        size="sm"
        variant={speech.listening ? "default" : "outline"}
        className={cn("gap-1", speech.listening && "bg-red-600 text-white hover:bg-red-600/90")}
        title={
          speech.listening
            ? `Listening in ${speech.lang} — click to stop`
            : `Dictate into the focused field (voice input, ${speech.lang})`
        }
        // Keep the caret where it is in the field being dictated into.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          speech.toggle();
          field()?.focus();
        }}
      >
        <Mic className={cn("size-3.5", speech.listening && "animate-pulse")} />
        {speech.listening ? `Listening · ${speech.lang}` : "Voice"}
      </Button>
    </span>
  );
}
