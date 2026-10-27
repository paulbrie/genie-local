"use client";

import { Subject } from "subjecto";

/**
 * The app's own confirm() and prompt(): promise-based, drawn by <AskHost> in the root layout with the app's dialog,
 * above everything (terminal windows included). One shows at a time; more wait their turn.
 *
 *   if (!(await confirmDialog(`Delete "${name}"?`, { confirmLabel: "Delete", destructive: true }))) return;
 *   const title = await promptDialog("Board name", current); // null when cancelled
 */
export type ConfirmOptions = {
  /** The heading; defaults to the message itself when that is short. */
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** A red confirm button, for what can't be undone. */
  destructive?: boolean;
};
export type PromptOptions = ConfirmOptions & { placeholder?: string };

export type AskRequest =
  | { id: number; kind: "confirm"; message: string; opts: ConfirmOptions; resolve: (ok: boolean) => void }
  | { id: number; kind: "prompt"; message: string; value: string; opts: PromptOptions; resolve: (value: string | null) => void };

/** What's waiting to be asked, the one on screen first. */
export const askQueue = new Subject<AskRequest[]>([], { name: "ask" });

let nextId = 1;
const enqueue = (r: AskRequest) => askQueue.next([...askQueue.getValue(), r]);

/** Settles the one on screen and shows the next. */
export function settleAsk(id: number, answer: boolean | string | null) {
  const r = askQueue.getValue().find((x) => x.id === id);
  if (!r) return;
  askQueue.next(askQueue.getValue().filter((x) => x.id !== id));
  if (r.kind === "confirm") r.resolve(answer === true);
  else r.resolve(typeof answer === "string" ? answer : null);
}

/** Resolves true on confirm, false on cancel (Escape, Cancel, a click outside). */
export function confirmDialog(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
  return new Promise((resolve) => enqueue({ id: nextId++, kind: "confirm", message, opts, resolve }));
}

/** Resolves the text entered, or null when cancelled, like window.prompt. */
export function promptDialog(message: string, value = "", opts: PromptOptions = {}): Promise<string | null> {
  return new Promise((resolve) => enqueue({ id: nextId++, kind: "prompt", message, value: value ?? "", opts, resolve }));
}
