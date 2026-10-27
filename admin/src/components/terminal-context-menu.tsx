"use client";

import { SquareTerminal, Trash2 } from "lucide-react";

import { killSession } from "@/components/terminal-dock";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { liveTerminals, openTerminal, setLiveTerminals } from "@/store/terminals";
import { confirmDialog } from "@/lib/ask";

/**
 * Right-click on a terminal in the sidebar: Open it, or Kill it (its tmux
 * session, and whatever runs in it, a Claude session included), after a confirm.
 */
export function TerminalContextMenu({
  name,
  claude,
  onNavigate,
  children,
}: {
  name: string;
  /** a Claude session runs in it: said in the confirm */
  claude: boolean;
  onNavigate: () => void;
  children: React.ReactNode;
}) {
  async function kill() {
    const what = claude ? "The Claude session in it ends" : "Running processes will stop";
    if (!(await confirmDialog(`Delete terminal "${name}"? ${what}.`, { confirmLabel: "Delete", destructive: true }))) return;
    // Gone from the sidebar now, not at the next poll.
    if (await killSession(name)) setLiveTerminals(liveTerminals.getValue().filter((t) => t.name !== name));
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuLabel className="truncate">{name}</ContextMenuLabel>
        <ContextMenuItem
          onClick={() => {
            openTerminal(name);
            onNavigate();
          }}
        >
          <SquareTerminal /> Open
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => void kill()}>
          <Trash2 /> Delete terminal…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
