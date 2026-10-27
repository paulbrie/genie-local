"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSubject } from "subjecto/react";

import { UploadList } from "@/components/files/upload-list";
import { Z_GLOBAL_CONTROLS } from "@/lib/z-layers";
import { isUploading, uploads } from "@/store/uploads";

/**
 * The Files page's uploads on every other page (store/uploads.ts), so one started there carries on, with its progress,
 * while you work elsewhere. Mounted once in the root layout. While any is still going, closing or reloading the tab
 * asks first: that would stop it.
 */
export function UploadDock() {
  const pathname = usePathname();
  const [list] = useSubject(uploads);
  const active = list.some(isUploading);

  useEffect(() => {
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);

  if (!list.length || pathname === "/files") return null;
  return (
    <div style={{ zIndex: Z_GLOBAL_CONTROLS }} className="fixed right-3 bottom-3 w-[30rem] max-w-[92vw]">
      <UploadList
        compact
        className="bg-background/95 shadow-2xl ring-1 ring-foreground/10 backdrop-blur"
        actions={<Link href="/files" className="hover:text-foreground">Open Files</Link>}
      />
    </div>
  );
}
