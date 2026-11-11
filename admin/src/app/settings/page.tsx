import { SettingsPanel } from "@/components/settings/settings-panel";

/** /settings: how the admin looks and how its desktop is laid out, kept in this browser. */
export default function SettingsPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          How the admin looks and how its desktop is laid out. These are kept in this browser, so another browser has
          its own.
        </p>
      </header>
      <SettingsPanel />
    </main>
  );
}
