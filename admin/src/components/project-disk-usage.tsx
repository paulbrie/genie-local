"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { HardDrive, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BASE_PATH } from "@/lib/config";
import type { DiskPart, DiskUsage, ProjectDisk } from "@/lib/disk-usage";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type Usage = Omit<DiskUsage, "projects"> & { projects: (ProjectDisk & { known: boolean })[] };

/**
 * The four kinds, in a fixed order, each its categorical slot (light / dark steps
 * checked for colour-blind separation; the light ones are below 3:1 on the card,
 * so every bar carries its figures in text and a table view).
 */
const PARTS: { key: DiskPart; label: string; hint: string; className: string }[] = [
  { key: "deps", label: "Dependencies", hint: "node_modules: reinstalled by npm install", className: "bg-[#2a78d6] dark:bg-[#3987e5]" },
  { key: "build", label: "Build output", hint: ".next, dist, .turbo, caches: rebuilt by a build", className: "bg-[#eb6834] dark:bg-[#d95926]" },
  { key: "git", label: "Git history", hint: ".git", className: "bg-[#1baf7a] dark:bg-[#199e70]" },
  { key: "other", label: "Everything else", hint: "code, data, assets", className: "bg-[#eda100] dark:bg-[#c98500]" },
];

const REFRESH_MS = 10 * 60_000;

/**
 * Dashboard card: how much disk each project folder takes, as a bar per project
 * split by kind (dependencies, build output, git history, the rest), biggest
 * first, scaled to the biggest; what could be rebuilt (and so cleared) is in the
 * header. Loads after the page (a scan takes a couple of seconds), every 10 min.
 */
export function ProjectDiskUsage() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [table, setTable] = useState(false);

  const load = useCallback(async (fresh = false) => {
    setBusy(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/disk-usage${fresh ? "?fresh=1" : ""}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setUsage(await res.json());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    // (off the mount tick: the scan shouldn't hold up the rest of the dashboard)
    const first = setTimeout(load, 0);
    const id = setInterval(load, REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [load]);

  const max = usage?.projects[0]?.bytes ?? 0;
  const rebuildable = usage?.projects.reduce((n, p) => n + p.parts.deps + p.parts.build, 0) ?? 0;

  return (
    <Card className="mt-3" data-testid="project-disk-usage">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm">
            <HardDrive className="size-4 text-muted-foreground" /> Disk by project
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            {usage
              ? `${formatBytes(usage.totalBytes)} in ${usage.projects.length} folders under ${usage.root} · ${formatBytes(rebuildable)} of it dependencies and build output, which a reinstall or build puts back · measured ${formatRelativeTime(new Date(usage.scannedAt))}`
              : error
                ? `Couldn't measure: ${error}`
                : "Measuring…"}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button size="xs" variant="ghost" onClick={() => setTable(!table)} disabled={!usage} aria-pressed={table}>
            {table ? "Bars" : "Table"}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => load(true)} disabled={busy} title="Measure again now">
            {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />} Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {usage && (
          <>
            <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {PARTS.map((p) => (
                <span key={p.key} className="flex items-center gap-1.5" title={p.hint}>
                  <span className={cn("size-2.5 rounded-sm", p.className)} />
                  {p.label}
                </span>
              ))}
            </div>
            {table ? (
              <table className="w-full text-xs" data-testid="disk-table">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-1 font-normal">Folder</th>
                    {PARTS.map((p) => (
                      <th key={p.key} className="py-1 text-right font-normal">{p.label}</th>
                    ))}
                    <th className="py-1 text-right font-normal">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.projects.map((p) => (
                    <tr key={p.name} className="border-t">
                      <td className="py-1">{p.name}</td>
                      {PARTS.map((part) => (
                        <td key={part.key} className="py-1 text-right font-mono tabular-nums">{formatBytes(p.parts[part.key])}</td>
                      ))}
                      <td className="py-1 text-right font-mono font-medium tabular-nums">{formatBytes(p.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <ul className="space-y-1.5" data-testid="disk-bars">
                {usage.projects.map((p) => {
                  const breakdown = PARTS.map((part) => `${part.label} ${formatBytes(p.parts[part.key])}`).join(" · ");
                  const name = <span className="truncate">{p.name}</span>;
                  return (
                    <li key={p.name} className="grid grid-cols-[9rem_1fr_4.5rem] items-center gap-3 text-xs" title={`${p.name}: ${formatBytes(p.bytes)}\n${breakdown}`}>
                      {p.known ? (
                        <Link href={`/projects/${encodeURIComponent(p.name)}`} className="truncate hover:underline">
                          {name}
                        </Link>
                      ) : (
                        name
                      )}
                      <div className="flex h-3 overflow-hidden rounded-sm" style={{ width: `${max ? Math.max(1, (p.bytes / max) * 100) : 0}%` }} aria-label={`${p.name}: ${breakdown}`}>
                        {PARTS.map((part) =>
                          p.parts[part.key] > 0 ? (
                            // (a hairline of the card between the parts, so neighbours read apart)
                            <div key={part.key} className={cn("h-full border-r-2 border-card last:border-r-0", part.className)} style={{ flexGrow: p.parts[part.key], flexBasis: 0 }} />
                          ) : null,
                        )}
                      </div>
                      <span className="text-right font-mono tabular-nums">{formatBytes(p.bytes)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
