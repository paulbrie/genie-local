"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { restoreProjectAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/** Un-archive a project so the scan tracks it again. Refreshes the page. */
export function RestoreProjectButton({ slug }: { slug: string }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <Button
      size="sm"
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          try {
            await restoreProjectAction(slug);
            toast.success(`Restored "${slug}"`);
            router.refresh();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
          }
        })
      }
    >
      <RotateCcw className="size-3.5" />
      {isPending ? "Restoring…" : "Restore to dashboard"}
    </Button>
  );
}
