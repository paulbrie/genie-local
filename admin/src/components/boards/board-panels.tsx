"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Pause, Play, Plus, RotateCcw, Send, Sparkles, Timer as TimerIcon, Trash2, Vote, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  CLAUDE_COLOR,
  CLAUDE_ID,
  newId,
  type Author,
  type BoardDoc,
  type CommentObj,
  type Meta,
} from "@/lib/boards/core.mjs";
import { cn } from "@/lib/utils";

import { initials } from "./identity";
import type { BoardSync } from "./sync";

export function Avatar({ user, size = 28, ring, className }: { user: Author; size?: number; ring?: boolean; className?: string }) {
  const isClaude = user.id === CLAUDE_ID;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white",
        ring && "ring-2 ring-background",
        className,
      )}
      style={{ width: size, height: size, background: user.color, fontSize: size * 0.4 }}
      title={user.name}
    >
      {isClaude ? <Sparkles style={{ width: size * 0.55, height: size * 0.55 }} /> : initials(user.name)}
    </span>
  );
}

function timeAgo(at: number) {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString();
}

// ------------------------------------------------------------------ Claude panel

const SUGGESTIONS = [
  "Group these stickies into themes",
  "Turn the selection into a flowchart",
  "Summarise the board so far",
  "Brainstorm 6 more ideas next to these",
  "Find duplicates and gaps",
];

export function ClaudePanel({
  sync,
  doc,
  busy,
  selection,
  viewport,
  onClose,
  onToggleFacilitator,
}: {
  sync: BoardSync;
  doc: BoardDoc;
  busy: boolean;
  selection: string[];
  viewport: () => { x: number; y: number; w: number; h: number };
  onClose: () => void;
  onToggleFacilitator: () => void;
}) {
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const lastText = doc.chat.at(-1)?.text;
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [doc.chat.length, lastText]);

  const ask = (q: string) => {
    const t = q.trim();
    if (!t || busy) return;
    sync.askClaude(t, selection, viewport());
    setText("");
  };

  return (
    <aside
      className="absolute bottom-3 right-3 top-16 z-40 flex w-[340px] flex-col overflow-hidden rounded-xl border bg-background/95 shadow-xl backdrop-blur"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Avatar user={{ id: CLAUDE_ID, name: "Claude", color: CLAUDE_COLOR }} size={24} />
        <div className="flex-1">
          <div className="text-sm font-semibold">Claude</div>
          <div className="text-[11px] text-muted-foreground">{busy ? "working on the board…" : "a participant on this board"}</div>
        </div>
        <Button size="icon-sm" variant="ghost" onClick={onClose} title="Close">
          <X />
        </Button>
      </header>
      <label className="flex cursor-pointer items-start gap-2 border-b px-3 py-2 text-xs">
        <input type="checkbox" className="mt-0.5" checked={doc.meta.facilitator} onChange={onToggleFacilitator} />
        <span>
          <span className="font-medium">Facilitate</span>
          <span className="block text-muted-foreground">
            After the group goes quiet, Claude may add a few suggestions you can keep or dismiss.
          </span>
        </span>
      </label>
      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto p-3">
        {doc.chat.length === 0 && (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              Ask Claude to work on the board with you. It sees everything on it, and what you have selected. You can also
              write <span className="font-mono text-foreground">@claude</span> in any comment.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="rounded-full border px-2 py-1 text-xs hover:bg-muted" onClick={() => ask(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {doc.chat.map((m) => (
          <div key={m.id} className={cn("flex gap-2", m.role === "user" && m.author.id === sync.user.id && "flex-row-reverse")}>
            <Avatar user={m.author} size={22} />
            <div
              className={cn(
                "max-w-[85%] rounded-lg px-2.5 py-1.5 text-sm",
                m.role === "claude" ? "bg-[#d97757]/12 dark:bg-[#d97757]/20" : "bg-muted",
              )}
            >
              <div className="mb-0.5 text-[10px] font-medium text-muted-foreground">{m.author.name}</div>
              <div className={cn("whitespace-pre-wrap break-words", m.pending && "animate-pulse")}>{m.text}</div>
            </div>
          </div>
        ))}
      </div>
      <form
        className="border-t p-2"
        onSubmit={(e) => {
          e.preventDefault();
          ask(text);
        }}
      >
        {selection.length > 0 && (
          <div className="mb-1.5 text-[11px] text-muted-foreground">
            With your selection ({selection.length} item{selection.length === 1 ? "" : "s"})
          </div>
        )}
        <div className="flex items-end gap-1.5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                ask(text);
              }
            }}
            rows={2}
            placeholder={busy ? "Claude is working…" : "Ask Claude…"}
            className="flex-1 resize-none rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring/40"
            data-testid="claude-input"
          />
          <Button type="submit" size="icon" disabled={busy || !text.trim()} title="Send">
            <Send />
          </Button>
        </div>
      </form>
    </aside>
  );
}

// ------------------------------------------------------------------ comments

export function CommentPopover({
  sync,
  comment,
  at,
  screen,
  area,
  onClose,
}: {
  sync: BoardSync;
  comment: CommentObj | null;
  /** World position for a new comment. */
  at: { x: number; y: number } | null;
  screen: { x: number; y: number };
  /** The board's size on screen, to keep the popover inside it. */
  area: { w: number; h: number };
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => inputRef.current?.focus(), [comment?.id]);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    if (comment) {
      sync.send1([{ k: "reply", id: comment.id, msg: { id: newId("m"), text: t } }]);
    } else if (at) {
      const id = newId("c");
      sync.apply([
        {
          k: "put",
          obj: {
            id,
            type: "comment",
            x: at.x,
            y: at.y,
            z: 0,
            thread: [{ id: newId("m"), author: sync.user, text: t, at: Date.now() }],
            resolved: false,
          },
        },
      ]);
      onClose();
    }
    setText("");
  };

  return (
    <div
      className="absolute z-40 w-80 rounded-xl border bg-background shadow-xl"
      style={{
        // Right of the pin, or left of it when there's no room.
        left: Math.max(8, screen.x + 40 + 328 > area.w ? screen.x - 328 : screen.x + 40),
        top: Math.max(64, Math.min(screen.y - 8, area.h - 400)),
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      data-testid="comment-popover"
    >
      <div className="flex items-center gap-1 border-b px-3 py-1.5">
        <span className="flex-1 text-xs font-medium text-muted-foreground">{comment ? "Comment" : "New comment"}</span>
        {comment && (
          <>
            <Button
              size="icon-xs"
              variant="ghost"
              title={comment.resolved ? "Reopen" : "Resolve"}
              onClick={() => sync.apply([{ k: "patch", id: comment.id, set: { resolved: !comment.resolved } }])}
            >
              {comment.resolved ? <RotateCcw /> : <Check />}
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              title="Delete thread"
              onClick={() => {
                sync.apply([{ k: "del", id: comment.id }]);
                onClose();
              }}
            >
              <Trash2 />
            </Button>
          </>
        )}
        <Button size="icon-xs" variant="ghost" title="Close" onClick={onClose}>
          <X />
        </Button>
      </div>
      {comment && (
        <div className="max-h-72 space-y-2.5 overflow-y-auto p-3">
          {comment.thread.map((m) => (
            <div key={m.id} className="flex gap-2">
              <Avatar user={m.author} size={22} />
              <div className="min-w-0 flex-1">
                <div className="text-xs">
                  <span className="font-medium">{m.author.name}</span>{" "}
                  <span className="text-muted-foreground">{timeAgo(m.at)}</span>
                </div>
                <div className="whitespace-pre-wrap break-words text-sm">{m.text}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-1.5 border-t p-2">
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape") onClose();
          }}
          rows={2}
          placeholder={comment ? "Reply… (@claude to ask Claude)" : "Comment… (@claude to ask Claude)"}
          className="flex-1 resize-none rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring/40"
          data-testid="comment-input"
        />
        <Button size="icon-sm" onClick={submit} disabled={!text.trim()} title="Send">
          <Send />
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ timer

function fmt(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function beep() {
  try {
    const ctx = new AudioContext();
    for (let i = 0; i < 3; i++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.3);
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + i * 0.3 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.3 + 0.25);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.3);
      o.stop(ctx.currentTime + i * 0.3 + 0.26);
    }
  } catch {
    /* no audio */
  }
}

/** The shared countdown: anyone can start, pause, add a minute or stop it. */
export function TimerControl({ sync, meta }: { sync: BoardSync; meta: Meta }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => sync.serverNow());
  const timer = meta.timer;
  const remaining = timer ? (timer.endsAt != null ? timer.endsAt - now : (timer.remainingMs ?? timer.durationMs)) : 0;
  const running = !!timer && timer.endsAt != null && remaining > 0;
  const done = !!timer && timer.endsAt != null && remaining <= 0;

  // Tick while it runs; also re-read the clock whenever the timer changes.
  const endsAt = timer?.endsAt ?? null;
  useEffect(() => {
    if (endsAt == null) return;
    const t = setInterval(() => setNow(sync.serverNow()), 250);
    const first = setTimeout(() => setNow(sync.serverNow()), 0);
    return () => {
      clearInterval(t);
      clearTimeout(first);
    };
  }, [endsAt, sync]);

  // Beep once when it runs out (not when joining long after).
  const firedFor = useRef<number | null>(null);
  useEffect(() => {
    if (done && endsAt != null && firedFor.current !== endsAt && now - endsAt < 5000) {
      firedFor.current = endsAt;
      beep();
    }
  }, [done, endsAt, now]);

  const set = (t: Meta["timer"]) => sync.send1([{ k: "meta", set: { timer: t } }]);
  const serverNow = () => sync.serverNow();

  if (!timer) {
    return (
      <div className="relative">
        <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} title="Timer">
          <TimerIcon /> Timer
        </Button>
        {open && (
          <div className="absolute right-0 top-9 z-50 flex gap-1 rounded-lg border bg-popover p-1.5 shadow-lg">
            {[1, 3, 5, 10, 15].map((m) => (
              <Button
                key={m}
                size="xs"
                variant="outline"
                onClick={() => {
                  set({ durationMs: m * 60_000, endsAt: serverNow() + m * 60_000, remainingMs: null });
                  setOpen(false);
                }}
              >
                {m} min
              </Button>
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      className={cn(
        "flex items-center gap-0.5 rounded-lg border px-1.5 py-0.5 font-mono text-sm tabular-nums",
        done && "animate-pulse border-red-500 text-red-600",
      )}
      data-testid="timer"
    >
      <TimerIcon className="mr-1 size-3.5" />
      {fmt(remaining)}
      {running ? (
        <Button size="icon-xs" variant="ghost" title="Pause" onClick={() => set({ ...timer, endsAt: null, remainingMs: remaining })}>
          <Pause />
        </Button>
      ) : (
        !done && (
          <Button size="icon-xs" variant="ghost" title="Resume" onClick={() => set({ ...timer, endsAt: serverNow() + remaining, remainingMs: null })}>
            <Play />
          </Button>
        )
      )}
      {!done && (
        <Button
          size="icon-xs"
          variant="ghost"
          title="Add a minute"
          onClick={() =>
            set(
              timer.endsAt != null
                ? { ...timer, endsAt: timer.endsAt + 60_000, durationMs: timer.durationMs + 60_000 }
                : { ...timer, remainingMs: remaining + 60_000, durationMs: timer.durationMs + 60_000 },
            )
          }
        >
          <Plus />
        </Button>
      )}
      <Button size="icon-xs" variant="ghost" title="Stop" onClick={() => set(null)}>
        <X />
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------ voting

export function VotingControl({ sync, doc }: { sync: BoardSync; doc: BoardDoc }) {
  const [open, setOpen] = useState(false);
  const voting = doc.meta.voting;
  let used = 0;
  let total = 0;
  for (const o of Object.values(doc.objects)) {
    used += o.votes?.[sync.user.id] ?? 0;
    for (const n of Object.values(o.votes ?? {})) total += n;
  }
  if (!voting) {
    return (
      <div className="relative">
        <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} title="Dot voting">
          <Vote /> Vote
        </Button>
        {open && (
          <div className="absolute right-0 top-9 z-50 w-56 space-y-2 rounded-lg border bg-popover p-2 text-xs shadow-lg">
            <div>Everyone gets this many votes; click items to vote, shift-click to take one back.</div>
            <div className="flex gap-1">
              {[1, 3, 5, 10].map((n) => (
                <Button
                  key={n}
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    sync.send1([{ k: "meta", set: { voting: { maxVotes: n } } }]);
                    setOpen(false);
                  }}
                >
                  {n}
                </Button>
              ))}
            </div>
            {total > 0 && (
              <Button size="xs" variant="ghost" className="text-destructive" onClick={() => sync.send1([{ k: "clearVotes" }])}>
                Clear all {total} votes
              </Button>
            )}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1 rounded-lg border border-violet-500/60 bg-violet-500/10 px-2 py-0.5 text-xs" data-testid="voting">
      <Vote className="size-3.5 text-violet-600" />
      <span>
        Voting: <b>{Math.max(0, voting.maxVotes - used)}</b> of {voting.maxVotes} left
      </span>
      <Button size="xs" variant="ghost" onClick={() => sync.send1([{ k: "meta", set: { voting: null } }])}>
        End
      </Button>
    </div>
  );
}
