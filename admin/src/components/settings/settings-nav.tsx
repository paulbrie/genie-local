"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { SETTINGS_PANES } from "@/components/settings/panes";
import { cn } from "@/lib/utils";

/** The Settings app's list of panes, the one shown picked (a column at the left; a row on a phone). */
export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings" className="flex shrink-0 gap-1 md:w-44 md:flex-col">
      <p className="hidden px-2.5 pb-1 text-xs font-medium text-muted-foreground md:block">Settings</p>
      {SETTINGS_PANES.map((p) => {
        const on = pathname === p.href;
        return (
          <Link
            key={p.href}
            href={p.href}
            aria-current={on ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground [&_svg]:size-4",
              on && "bg-accent text-foreground",
            )}
          >
            <p.icon />
            {p.label}
          </Link>
        );
      })}
    </nav>
  );
}
