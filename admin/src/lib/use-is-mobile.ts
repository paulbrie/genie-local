"use client";

import { useEffect, useState } from "react";

/**
 * True on small screens. Defaults to Tailwind's `md` breakpoint (< 768px), the
 * width below which the app switches to its mobile layout (drawer nav, full-screen
 * terminal, stacked tables). SSR-safe: starts false, corrects after mount.
 */
export function useIsMobile(query = "(max-width: 767px)"): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return isMobile;
}
