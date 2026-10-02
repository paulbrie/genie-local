import { ProcessesTable } from "@/components/processes-table";

export const dynamic = "force-dynamic";

export default function ProcessesPage() {
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 space-y-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Processes</h1>
        <p className="text-sm text-muted-foreground">
          Live process list and listening ports (from the vps-stats daemon).
        </p>
      </header>
      <ProcessesTable />
    </main>
  );
}
