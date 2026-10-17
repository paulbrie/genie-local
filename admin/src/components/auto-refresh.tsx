"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-render the page's server data every `ms` while the tab is visible. */
export function AutoRefresh({ ms }: { ms: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, ms);
    return () => clearInterval(id);
  }, [router, ms]);
  return null;
}
