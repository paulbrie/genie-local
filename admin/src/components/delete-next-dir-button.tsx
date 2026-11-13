"use client";

import { useTransition } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import { deleteNextDirAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/lib/ask";

/**
 * Deletes a Next.js app's `.next` after a confirm, which names the scripts it stops first and starts again after
 * (`running`). The tab refreshes from the action's revalidate.
 */
export function DeleteNextDirButton({
  slug,
  appId,
  label,
  size,
  running,
  disabled,
}: {
  slug: string;
  appId: number;
  label: string;
  size: string;
  running: string[];
  disabled?: boolean;
}) {
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      size="sm"
      variant="destructive"
      disabled={disabled || isPending}
      onClick={async () => {
        const restart = running.length
          ? ` ${running.join(", ")} ${running.length === 1 ? "is" : "are"} stopped first and started again after.`
          : "";
        if (
          !(await confirmDialog(
            `Next.js builds it again on the next dev or build (${size} now).${restart}`,
            { title: `Delete ${label}'s .next?`, confirmLabel: "Delete", destructive: true },
          ))
        )
          return;
        startTransition(async () => {
          try {
            const { restarted } = await deleteNextDirAction(slug, appId);
            toast.success(
              restarted.length ? `Deleted .next, restarted ${restarted.join(", ")}` : `Deleted ${label}'s .next`,
            );
          } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
          }
        });
      }}
    >
      <Trash2 className="size-3.5" />
      {isPending ? "Deleting…" : "Delete .next"}
    </Button>
  );
}
