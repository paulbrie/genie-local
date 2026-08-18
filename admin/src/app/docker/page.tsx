import { DockerManager } from "@/components/docker-manager";

export const dynamic = "force-dynamic";

export default function DockerPage() {
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 space-y-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Docker</h1>
        <p className="text-sm text-muted-foreground">
          Containers and images on the local Docker daemon. Start, stop,
          restart, remove, and tail logs.
        </p>
      </header>
      <DockerManager />
    </main>
  );
}
