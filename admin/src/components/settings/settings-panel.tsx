"use client";

import { AlignCenter, AlignLeft, AlignRight, Monitor, Moon, PanelLeft, Sun, SunMoon } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useSyncExternalStore } from "react";
import { useSubject } from "subjecto/react";

import { AppIcon, VsCodeIcon } from "@/components/desktop/app-icon";
import { useShellMode } from "@/components/desktop/shell-mode";
import { NAV_FLAT, NAV_HREFS } from "@/components/nav-items";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { type DeskAlign, DOCK_ICON, VSCODE_ICON, WIDGETS } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { desk, loadDesk, restoreIcons, setAlign, setDockSize, setIcons, setOnDesktop, setWidgetMode } from "@/store/desktop";

/**
 * The Settings app (/settings): the interface and the theme, and the desktop's arrangement, dock, widgets and icons
 * (`desk`, this browser's localStorage). It reads them itself (loadDesk), so it works from the classic interface too,
 * and a change made here in a window's frame reaches the desktop around it.
 */
export function SettingsPanel() {
  const [d] = useSubject(desk);
  const { mode, setMode } = useShellMode();
  const { theme, setTheme } = useTheme();
  // (the theme is only known in the browser: until then nothing shows as picked)
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  useEffect(() => loadDesk(NAV_HREFS), []);

  const dock = d.dockSize ?? DOCK_ICON.default;
  const removed = new Set(d.removedIcons ?? []);
  const icons = [
    ...NAV_FLAT.map((i) => ({ id: i.href, label: i.label, icon: <AppIcon item={i} size={22} /> })),
    { id: VSCODE_ICON, label: "VS Code", icon: <VsCodeIcon size={22} /> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <Setting label="Interface" hint="The classic view with its sidebar, or a desktop with windows, icons and a dock.">
            <Segmented
              value={mode}
              onChange={setMode}
              options={[
                { value: "classic", label: "Classic", icon: PanelLeft },
                { value: "desktop", label: "Desktop", icon: Monitor },
              ]}
            />
          </Setting>
          <Setting label="Theme">
            <Segmented
              value={mounted ? (theme ?? "system") : null}
              onChange={setTheme}
              options={[
                { value: "light", label: "Light", icon: Sun },
                { value: "dark", label: "Dark", icon: Moon },
                { value: "system", label: "Automatic", icon: SunMoon },
              ]}
            />
          </Setting>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Desktop</CardTitle>
          <CardDescription>
            {mode === "desktop" ? "The desktop interface: its icons, widgets and dock." : "For the desktop interface (switch to it above)."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <Setting label="Arrangement" hint="The icons and widgets as you've laid them out, kept together against the left, in the middle, or against the right.">
            <Segmented<DeskAlign>
              value={d.align ?? "left"}
              onChange={setAlign}
              options={[
                { value: "left", label: "Left", icon: AlignLeft },
                { value: "center", label: "Centre", icon: AlignCenter },
                { value: "right", label: "Right", icon: AlignRight },
              ]}
            />
          </Setting>

          <Setting label="Dock size" hint="Or drag the line between the dock's icons up or down.">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={DOCK_ICON.min}
                max={DOCK_ICON.max}
                step={2}
                value={dock}
                onChange={(e) => setDockSize(Number(e.target.value))}
                aria-label="Dock size"
                className="w-48 accent-primary"
              />
              <span className="w-12 text-sm text-muted-foreground tabular-nums">{dock} px</span>
              {dock !== DOCK_ICON.default && (
                <Button variant="ghost" size="sm" onClick={() => setDockSize(DOCK_ICON.default)}>
                  Default
                </Button>
              )}
            </div>
          </Setting>

          <Setting label="Widgets" hint="Each is moved by its header and resized from its edges, on the desktop itself.">
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {WIDGETS.map((id) => (
                <label key={id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={d.widgets?.[id]?.mode !== "hidden"}
                    onCheckedChange={(on) => setWidgetMode(id, on ? "open" : "hidden")}
                  />
                  {id === "terminals" ? "Terminals" : "Projects"}
                </label>
              ))}
            </div>
          </Setting>

          <Setting
            label="Icons on the desktop"
            hint="One taken off stays in the Launchpad and the dock, whose menus put it back too."
            actions={
              <>
                {removed.size > 0 && (
                  <Button variant="outline" size="sm" onClick={restoreIcons}>
                    Show all
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => setIcons(null)}>
                  Reset their order
                </Button>
              </>
            }
          >
            <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-x-4 gap-y-1.5">
              {icons.map((i) => (
                <label key={i.id} className="flex min-w-0 items-center gap-2 rounded-md py-0.5 text-sm">
                  <Checkbox checked={!removed.has(i.id)} onCheckedChange={(on) => setOnDesktop(i.id, on)} />
                  {i.icon}
                  <span className="truncate">{i.label}</span>
                </label>
              ))}
            </div>
          </Setting>
        </CardContent>
      </Card>
    </div>
  );
}

/** One setting: its name (and what it does), then its control; buttons that act on it at the right of the name. */
function Setting({ label, hint, actions, children }: { label: string; hint?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">{label}</h3>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** A choice of a few, side by side (the one picked pressed). */
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  /** null: none shows as picked (not known yet) */
  value: T | null;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon: typeof Sun }[];
}) {
  return (
    <div role="group" className="inline-flex w-fit rounded-lg bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-3 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground [&_svg]:size-3.5",
            value === o.value && "bg-background text-foreground shadow-sm ring-1 ring-foreground/10",
          )}
        >
          <o.icon />
          {o.label}
        </button>
      ))}
    </div>
  );
}
