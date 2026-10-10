import { NginxManager } from "@/components/nginx-manager";

export const dynamic = "force-dynamic";

export default function NginxPage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col space-y-4 overflow-hidden p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Nginx</h1>
        <p className="text-sm text-muted-foreground">
          View and edit the system Nginx config. Saving backs up the file, runs{" "}
          <code className="font-mono text-xs">nginx -t</code>, and reloads on
          success — or rolls back if the config is invalid. The generated{" "}
          <code className="font-mono text-xs">projects.conf</code> include is
          read-only.
        </p>
      </header>
      <NginxManager />
    </main>
  );
}
