"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { setAppRunSettingsAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RUN_ISOLATIONS, type RunIsolation, type RunSettings } from "@/lib/run-isolation";

const ISOLATION_LABEL: Record<RunIsolation, string> = { process: "On the box", docker: "Docker" };

/** How an app's scripts run: on the box or in Docker, with a memory and a CPU cap (src/lib/run-isolation.ts). */
export function AppRunForm({
  projectSlug,
  appId,
  initial,
  can,
  autoImage,
}: {
  projectSlug: string;
  appId: number;
  initial: RunSettings;
  /** What the box offers: its own systemd scope per run (for the caps), Docker. */
  can: { scopes: boolean; docker: boolean };
  /** The image a docker run gets when none is named. */
  autoImage: string;
}) {
  const [isolation, setIsolation] = useState<RunIsolation>(initial.isolation);
  const [image, setImage] = useState(initial.image ?? "");
  const [mem, setMem] = useState(initial.memMaxMb?.toString() ?? "");
  const [cpus, setCpus] = useState(initial.cpus?.toString() ?? "");
  const [saved, setSaved] = useState(initial);
  const [isPending, startTransition] = useTransition();

  const num = (s: string) => (s.trim() === "" ? null : Number(s.trim()));
  const next: RunSettings = {
    isolation,
    image: isolation === "docker" && image.trim() ? image.trim() : null,
    memMaxMb: num(mem),
    cpus: num(cpus),
  };
  const changed = JSON.stringify(next) !== JSON.stringify(saved);

  function save() {
    if (next.memMaxMb !== null && (!Number.isInteger(next.memMaxMb) || next.memMaxMb < 64)) {
      toast.error("Memory: a whole number of MB, 64 or more (or empty for no cap)");
      return;
    }
    if (next.cpus !== null && (!Number.isFinite(next.cpus) || next.cpus < 0.1)) {
      toast.error("CPUs: a number of cores, 0.1 or more, e.g. 1.5 (or empty for no cap)");
      return;
    }
    startTransition(async () => {
      try {
        await setAppRunSettingsAction(projectSlug, appId, next);
        setSaved(next);
        toast.success("Saved: taken at each script's next start");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    });
  }

  const hint =
    isolation === "docker"
      ? can.docker
        ? "In a container: the project mounted at its own path, the host's network, as genie; only what the admin keeps of its env goes in."
        : "Docker isn't available on this box: a start will fail until it is."
      : can.scopes
        ? "On the box, in a systemd scope of its own: the caps hold for everything it starts, and Stop takes all of it."
        : "On the box. No systemd user manager here, so caps can't apply (sudo loginctl enable-linger genie).";

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Runs</span>
          <div className="flex rounded-md border p-0.5" role="radiogroup" aria-label="Where its scripts run">
            {RUN_ISOLATIONS.map((i) => (
              <Button
                key={i}
                size="sm"
                variant={isolation === i ? "secondary" : "ghost"}
                className="h-6 px-2 text-xs"
                role="radio"
                aria-checked={isolation === i}
                onClick={() => setIsolation(i)}
              >
                {ISOLATION_LABEL[i]}
              </Button>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Memory</span>
          <Input value={mem} onChange={(e) => setMem(e.target.value)} inputMode="numeric" placeholder="—" className="h-7 w-20" aria-label="Memory cap in MB" />
          <span className="text-xs text-muted-foreground">MB</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">CPUs</span>
          <Input value={cpus} onChange={(e) => setCpus(e.target.value)} inputMode="decimal" placeholder="—" className="h-7 w-16" aria-label="CPU cap in cores" />
        </label>
        {isolation === "docker" && (
          <label className="flex min-w-0 items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Image</span>
            <Input value={image} onChange={(e) => setImage(e.target.value)} placeholder={autoImage} className="h-7 w-52 font-mono text-xs" aria-label="Docker image" />
          </label>
        )}
        <Button size="sm" variant="outline" className="h-7" disabled={isPending || !changed} onClick={save}>
          {isPending ? "Saving…" : "Save"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{hint} Taken at each script&apos;s next start.</p>
    </div>
  );
}
