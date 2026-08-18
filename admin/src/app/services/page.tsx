import { ServicesManager } from "@/components/services-manager";

export const dynamic = "force-dynamic";

export default function ServicesPage() {
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 space-y-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Services</h1>
        <p className="text-sm text-muted-foreground">
          systemd service units. Start, stop, restart, enable/disable at boot,
          and tail journal logs. A few critical units are protected from
          stop/disable.
        </p>
      </header>
      <ServicesManager />
    </main>
  );
}
