"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { setAppPortAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function AppPortForm({
  projectSlug,
  appId,
  port,
}: {
  projectSlug: string;
  appId: number;
  port: number | null;
}) {
  const [value, setValue] = useState(port?.toString() ?? "");
  const [isPending, startTransition] = useTransition();

  function save() {
    const trimmed = value.trim();
    const parsed = trimmed === "" ? null : Number(trimmed);
    if (
      parsed !== null &&
      (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535)
    ) {
      toast.error("Port must be an integer between 1 and 65535 (or empty)");
      return;
    }
    startTransition(async () => {
      try {
        const res = await setAppPortAction(projectSlug, appId, parsed);
        if (res.ok) {
          toast.success(
            parsed === null ? "Port cleared — nginx reloaded" : `Port set to ${parsed} — nginx reloaded`,
          );
        } else {
          toast.error(res.message);
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">Port</span>
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
        }}
        inputMode="numeric"
        placeholder="—"
        className="h-7 w-24"
        aria-label={`Port for ${projectSlug} app`}
      />
      <Button
        size="sm"
        variant="outline"
        className="h-7"
        disabled={isPending}
        onClick={save}
      >
        {isPending ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}
