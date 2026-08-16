"use client";

import { useTransition } from "react";
import { toast } from "sonner";

import { rescanProjectAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

export function RescanProjectButton({ slug }: { slug: string }) {
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          try {
            await rescanProjectAction(slug);
            toast.success("Snapshot captured");
          } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
          }
        })
      }
    >
      {isPending ? "Rescanning…" : "Rescan"}
    </Button>
  );
}
