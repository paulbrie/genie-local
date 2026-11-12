"use client";

import { AlignCenter, AlignLeft, AlignRight, Code2, Monitor, Moon, PanelLeft, Sun, SunMoon } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useSyncExternalStore } from "react";
import { useSubject } from "subjecto/react";

import { useShellMode } from "@/components/desktop/shell-mode";
import { NAV, NAV_HREFS, type NavItem } from "@/components/nav-items";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { type DeskAlign, NAV_ALWAYS, navShown, SIDEBAR_ICON, VSCODE_NAV, WIDGET_LABEL, widgetMode, WIDGETS } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { desk, loadDesk, setAlign, setNavShown, setSidebarSize, setWidgetMode, showAllNav } from "@/store/desktop";

/**
 * The Settings app (/settings): the interface and the theme, the sidebar's items (in both interfaces) and size, and the
 * desktop's Home, its widgets and their arrangement (`desk`, this browser's localStorage). It reads them itself
 * (loadDesk), so it works from the classic interface too, and a change made here in a pop-up's frame reaches the
 * desktop around it.
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

  const side = d.sidebarSize ?? SIDEBAR_ICON.default;
  // Every item the sidebar can show, in its order (a group's under it, set in), VS Code last; the home as this
  // interface names it.
  const item = (i: NavItem, parent?: string) => ({
    id: i.href,
    label: mode === "desktop" && i.desktop ? i.desktop.label : i.label,
    icon: mode === "desktop" && i.desktop ? i.desktop.icon : i.icon,
    parent,
  });
  const items = [
    ...NAV.flatMap((i) => [item(i), ...(i.children ?? []).map((c) => item(c, i.href))]),
    { id: VSCODE_NAV, label: "VS Code", icon: Code2, parent: undefined },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <Setting label="Interface" hint="The classic view with its sidebar, or the desktop: the same sidebar, Home with its widgets, and pages that pop out as windows.">
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
          <CardTitle>Sidebar</CardTitle>
          <CardDescription>The one in both interfaces.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <Setting
            label="Items"
            hint="The ones it shows. A right-click on one in the sidebar hides it too; the home and Settings always stay."
            actions={
              d.hiddenNav?.length ? (
                <Button variant="outline" size="sm" onClick={showAllNav}>
                  Show all
                </Button>
              ) : null
            }
          >
            <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-x-4 gap-y-1.5">
              {items.map((i) => {
                const always = NAV_ALWAYS.includes(i.id);
                // (a group's item goes with it: off while the group is)
                const under = !!i.parent && !navShown(d.hiddenNav, i.parent);
                return (
                  <label
                    key={i.id}
                    title={always ? "Always in the sidebar" : under ? "Its group is hidden" : undefined}
                    className={cn("flex min-w-0 items-center gap-2 rounded-md py-0.5 text-sm", i.parent && "pl-6", (always || under) && "text-muted-foreground")}
                  >
                    <Checkbox
                      checked={navShown(d.hiddenNav, i.id) && !under}
                      disabled={always || under}
                      onCheckedChange={(on) => setNavShown(i.id, on)}
                    />
                    <i.icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{i.label}</span>
                  </label>
                );
              })}
            </div>
          </Setting>

          <Setting label="Size" hint="In the desktop interface: how big its icons and rows are (the default is classic's).">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={SIDEBAR_ICON.min}
                max={SIDEBAR_ICON.max}
                step={2}
                value={side}
                onChange={(e) => setSidebarSize(Number(e.target.value))}
                aria-label="Sidebar size"
                className="w-48 accent-primary"
              />
              <span className="w-12 text-sm text-muted-foreground tabular-nums">{side} px</span>
              {side !== SIDEBAR_ICON.default && (
                <Button variant="ghost" size="sm" onClick={() => setSidebarSize(SIDEBAR_ICON.default)}>
                  Default
                </Button>
              )}
            </div>
          </Setting>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Home</CardTitle>
          <CardDescription>
            {mode === "desktop" ? "The desktop interface's Home: its widgets." : "For the desktop interface's Home (switch to it above)."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <Setting label="Arrangement" hint="The widgets as you've laid them out, kept together against the left, in the middle, or against the right.">
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

          <Setting label="Widgets" hint="Each is moved by its header and resized from its edges, on Home itself.">
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {WIDGETS.map((id) => (
                <label key={id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={widgetMode(d.widgets, id) !== "hidden"}
                    onCheckedChange={(on) => setWidgetMode(id, on ? "open" : "hidden")}
                  />
                  {WIDGET_LABEL[id]}
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
