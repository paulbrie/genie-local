import { FileExplorer } from "@/components/files/file-explorer";
import { fileRoots, writeRoots } from "@/lib/files/guard";

export const dynamic = "force-dynamic";

export default function FilesPage() {
  return (
    <main className="flex h-[calc(100vh-3.5rem)] w-full flex-1 flex-col gap-3 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Files</h1>
        <p className="text-sm text-muted-foreground">
          Browse and preview files under{" "}
          {fileRoots().map((r, i) => <span key={r}>{i > 0 && " and "}<code className="font-mono">{r}</code></span>)} (what the genie user can read);
          upload (any size), rename, move and delete under{" "}
          {writeRoots().map((r, i) => <span key={r}>{i > 0 && ", "}<code className="font-mono">{r}</code></span>)}. Deleted items go to the trash first.
        </p>
      </header>
      <FileExplorer />
    </main>
  );
}
