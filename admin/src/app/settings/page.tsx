import { SettingsPanel } from "@/components/settings/settings-panel";

/** /settings, General: how the admin looks and how its desktop is laid out, kept in this browser. */
export default function GeneralSettingsPage() {
  return (
    <>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">General</h1>
        <p className="text-sm text-muted-foreground">
          How the admin looks and how its desktop is laid out. These are kept in this browser, so another browser has
          its own.
        </p>
      </header>
      <SettingsPanel />
    </>
  );
}
