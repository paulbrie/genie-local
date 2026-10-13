import { NginxManager } from "@/components/nginx-manager";
import { NginxRoutes } from "@/components/nginx/nginx-routes";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { loadRouteSnapshot } from "@/lib/nginx";

export const dynamic = "force-dynamic";

/**
 * Nginx (T242): the Routes tab maps every host, path, port and process, flags
 * the problems, and changes an app's port through the generated include (with a
 * preview and a rollback); the Files tab edits the config files themselves.
 */
export default async function NginxPage() {
  const snapshot = await loadRouteSnapshot();
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col space-y-4 overflow-hidden p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Nginx</h1>
        <p className="text-sm text-muted-foreground">
          Every route, from host and path to port and the process behind it. An app&rsquo;s port is set
          here through the generated <code className="font-mono text-xs">projects.conf</code>: previewed,
          checked for conflicts, then applied with <code className="font-mono text-xs">nginx -t</code> and
          rolled back if it fails. Hand-written files are shown here and edited in Files.
        </p>
      </header>
      <Tabs defaultValue="routes" className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="routes">Routes</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
        </TabsList>
        <TabsContent value="routes" className="flex min-h-0 flex-1 flex-col pt-3">
          <NginxRoutes snapshot={snapshot} />
        </TabsContent>
        <TabsContent value="files" className="flex min-h-0 flex-1 flex-col space-y-3 pt-3">
          <p className="text-sm text-muted-foreground">
            View and edit the system Nginx config. Saving backs up the file, runs{" "}
            <code className="font-mono text-xs">nginx -t</code>, and reloads on success — or rolls back
            if the config is invalid. The generated <code className="font-mono text-xs">projects.conf</code>{" "}
            include is read-only.
          </p>
          <NginxManager />
        </TabsContent>
      </Tabs>
    </main>
  );
}
