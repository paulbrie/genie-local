"use client";

import { useEffect, useRef, useState } from "react";
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { useSubject } from "subjecto/react";

import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { askQueue, settleAsk, type AskRequest } from "@/lib/ask";
import { cn } from "@/lib/utils";
import { Z_GLOBAL_OVERLAY } from "@/lib/z-layers";

/** Long messages read as the body under a short heading rather than as the heading. */
const SHORT = 90;

/**
 * Draws confirmDialog() / promptDialog() (src/lib/ask.ts) one at a time, in the
 * app's dialog style, above the terminal windows and the docks. Mounted once in
 * the root layout.
 */
export function AskHost() {
  const [queue] = useSubject(askQueue);
  const current = queue[0];
  return (
    <AlertDialogPrimitive.Root
      open={!!current}
      onOpenChange={(open) => {
        if (!open && current) settleAsk(current.id, current.kind === "confirm" ? false : null);
      }}
    >
      {current && <AskPopup key={current.id} r={current} />}
    </AlertDialogPrimitive.Root>
  );
}

function AskPopup({ r }: { r: AskRequest }) {
  const [value, setValue] = useState(r.kind === "prompt" ? r.value : "");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (r.kind === "prompt") input.current?.select();
  }, [r.kind]);

  const short = r.message.length <= SHORT && !r.message.includes("\n");
  const title = r.opts.title ?? (short ? r.message : r.kind === "prompt" ? "Enter a value" : "Are you sure?");
  const body = r.opts.title || !short ? r.message : null;
  const ok = () => settleAsk(r.id, r.kind === "confirm" ? true : value);

  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Backdrop
        style={{ zIndex: Z_GLOBAL_OVERLAY + 1 }}
        className="fixed inset-0 bg-black/20 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0"
      />
      <AlertDialogPrimitive.Popup
        style={{ zIndex: Z_GLOBAL_OVERLAY + 2 }}
        data-testid="ask-dialog"
        // (the page under it keeps its shortcuts to itself while it is open: Escape still closes it)
        onKeyDown={(e) => {
          if (e.key !== "Escape") e.stopPropagation();
        }}
        className="fixed top-1/2 left-1/2 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-5 text-sm text-popover-foreground ring-1 ring-foreground/10 outline-none sm:max-w-md data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95"
      >
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            ok();
          }}
        >
          <div className="flex flex-col gap-2">
            <AlertDialogPrimitive.Title className="text-base leading-snug font-medium">{title}</AlertDialogPrimitive.Title>
            {body && (
              <AlertDialogPrimitive.Description className="max-h-[50vh] overflow-auto text-sm whitespace-pre-line text-muted-foreground">
                {body}
              </AlertDialogPrimitive.Description>
            )}
          </div>
          {r.kind === "prompt" && (
            <Input
              ref={input}
              autoFocus
              aria-label={title}
              value={value}
              placeholder={r.opts.placeholder}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AlertDialogPrimitive.Close className={buttonVariants({ variant: "outline" })}>
              {r.opts.cancelLabel ?? "Cancel"}
            </AlertDialogPrimitive.Close>
            <button
              type="submit"
              autoFocus={r.kind === "confirm"}
              className={cn(buttonVariants({ variant: r.opts.destructive ? "destructive" : "default" }))}
            >
              {r.opts.confirmLabel ?? "OK"}
            </button>
          </div>
        </form>
      </AlertDialogPrimitive.Popup>
    </AlertDialogPrimitive.Portal>
  );
}
