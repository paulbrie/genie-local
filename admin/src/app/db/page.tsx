import { DbExplorer } from "@/components/db/db-explorer";

export const dynamic = "force-dynamic";

export default function DbPage() {
  return (
    <main className="mx-auto w-full max-w-7xl flex-1 space-y-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">DB Explorer</h1>
        <p className="text-sm text-muted-foreground">
          Browse Postgres &amp; MySQL, edit rows, run and save queries.
        </p>
      </header>
      <DbExplorer />
    </main>
  );
}
