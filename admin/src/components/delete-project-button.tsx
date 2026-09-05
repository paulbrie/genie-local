"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import { deleteProjectAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/**
 * Removes a project from the dashboard (archives it). Deliberately NON-destructive
 * on disk — the confirm copy says so — and reversible via the restore banner on
 * the project's page. Redirects to the dashboard on success.
 */
export function DeleteProjectButton({ slug }: { slug: string }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <Button
      size="sm"
      variant="destructive"
      disabled={isPending}
      onClick={() => {
        if (
          !confirm(
            `Remove "${slug}" from the dashboard?\n\n` +
              `The files on disk are NOT deleted — this only stops the admin from ` +
              `tracking it. You can restore it later from this project's URL.`,
          )
        )
          return;
        startTransition(async () => {
          try {
            await deleteProjectAction(slug);
            toast.success(`Removed "${slug}" from the dashboard`);
            router.push("/");
          } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
          }
        });
      }}
    >
      <Trash2 className="size-3.5" />
      {isPending ? "Removing…" : "Delete"}
    </Button>
  );
}
