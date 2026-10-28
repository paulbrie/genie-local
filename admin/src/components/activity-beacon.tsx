"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

import { BASE_PATH } from "@/lib/config";

/**
 * Reports client-side navigations as page views (POST /api/activity). The
 * first page of a tab was a document load the proxy already recorded, so only
 * a change of pathname is sent; a query-string change isn't a new page.
 */
export function ActivityBeacon() {
  const pathname = usePathname();
  const last = useRef(pathname);

  useEffect(() => {
    if (last.current === pathname) return;
    last.current = pathname;
    const body = JSON.stringify({ path: pathname });
    try {
      if (!navigator.sendBeacon?.(`${BASE_PATH}/api/activity`, body)) {
        void fetch(`${BASE_PATH}/api/activity`, { method: "POST", body, keepalive: true }).catch(() => {});
      }
    } catch {
      /* analytics never gets in the way */
    }
  }, [pathname]);

  return null;
}
