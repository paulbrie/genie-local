"use client";

import { Menu } from "@base-ui/react/menu";
import type { LucideIcon } from "lucide-react";

/**
 * The menu a right-click on a file's column opens in the Ops view (T215): at the pointer, kept on screen near the
 * edges, the file's path as its header, then its items (a list: more will come). Base UI's Menu, as the admin's
 * context menus (ui/context-menu.tsx) and in their style, but opened by the map (only over a column; elsewhere the
 * browser's own menu, and a right-drag still pans): Esc, a click outside, arrows and Enter are the Menu's; the map
 * closes it as it scrolls or zooms.
 */

export type FileMenuItem = { label: string; icon?: LucideIcon; onSelect: () => void };
export type FileMenuAt = { x: number; y: number; title: string; items: FileMenuItem[] };

export function FileMenu({ at, onClose }: { at: FileMenuAt | null; onClose: () => void }) {
  // (a point at the pointer for the menu to stand by)
  const anchor = at && { getBoundingClientRect: () => DOMRect.fromRect({ x: at.x, y: at.y, width: 0, height: 0 }) };
  return (
    <Menu.Root open={!!at} onOpenChange={(open) => !open && onClose()} modal={false}>
      <Menu.Portal>
        <Menu.Positioner anchor={anchor} side="bottom" align="start" sideOffset={2} collisionPadding={8} className="isolate z-50 outline-none">
          <Menu.Popup className="max-w-[min(28rem,90vw)] min-w-44 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none">
            {at && (
              <>
                <div className="truncate px-2 pt-1 pb-1.5 font-mono text-[11px] text-muted-foreground" title={at.title}>{at.title}</div>
                {at.items.map((it) => (
                  <Menu.Item key={it.label} onClick={it.onSelect} className="relative flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0">
                    {it.icon && <it.icon aria-hidden />}
                    {it.label}
                  </Menu.Item>
                ))}
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
