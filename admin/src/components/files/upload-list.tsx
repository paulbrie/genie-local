"use client";

import type { ReactNode } from "react";
import { X } from "lucide-react";
import { useSubject } from "subjecto/react";

import { cn } from "@/lib/utils";
import { clearFinishedUploads, isUploading, uploads } from "@/store/uploads";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** The uploads (store/uploads.ts) with their progress and a cancel button, on the Files page and in the upload dock. */
export function UploadList({ className, compact, actions }: { className?: string; compact?: boolean; actions?: ReactNode }) {
  const [list] = useSubject(uploads);
  if (!list.length) return null;
  const active = list.filter(isUploading).length;
  return (
    <section aria-label="Uploads" className={cn("rounded-lg border p-2", className)}>
      <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
        <span>Uploads{active ? ` · ${active} in progress` : ""}</span>
        <span className="flex items-center gap-3">
          {actions}
          <button type="button" className="hover:text-foreground" onClick={clearFinishedUploads}>Clear finished</button>
        </span>
      </div>
      <ul className="max-h-40 space-y-1 overflow-auto">
        {list.map((u) => {
          const pct = u.size ? Math.floor((u.sent / u.size) * 100) : 100;
          return (
            <li key={u.key} className="flex items-center gap-2 text-xs">
              <span className={cn("truncate", compact ? "w-32" : "w-56")} title={`${u.dir}/${u.name}`}>{u.name}</span>
              <span className="h-2 flex-1 overflow-hidden rounded bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`Upload of ${u.name}`}>
                <span className={cn("block h-full", u.status === "error" ? "bg-destructive" : u.status === "done" ? "bg-emerald-500" : "bg-primary")} style={{ width: `${pct}%` }} />
              </span>
              <span className={cn("whitespace-nowrap text-right tabular-nums text-muted-foreground", compact ? "w-40" : "w-72")}>
                {u.status === "uploading"
                  ? compact
                    ? `${pct}%${u.bytesPerSec != null ? ` · ${formatBytes(u.bytesPerSec)}/s` : ""}`
                    : `${pct}% · ${formatBytes(u.sent)} / ${formatBytes(u.size)}${u.bytesPerSec != null ? ` · ${formatBytes(u.bytesPerSec)}/s` : ""}`
                  : u.status === "done" ? "done" : u.status === "cancelled" ? "cancelled" : <span className="text-destructive" title={u.error}>failed: {u.error}</span>}
              </span>
              {u.status === "uploading" && <button type="button" aria-label={`Cancel ${u.name}`} onClick={() => u.abort.abort()} className="rounded p-0.5 hover:bg-muted"><X className="size-3.5" /></button>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
