"use client";

import { useEffect } from "react";

/**
 * Marks whatever is scrolling with `data-scrolling` for a moment (globals.css shows its scrollbar meanwhile, as it
 * does while the pointer is over it): a wheel, a trackpad or the keyboard scroll it without hovering it.
 */
export function useScrollActivity(ms = 900) {
  useEffect(() => {
    const timers = new WeakMap<Element, number>();
    const onScroll = (e: Event) => {
      const el = e.target === document ? document.documentElement : e.target;
      if (!(el instanceof Element)) return;
      if (!el.hasAttribute("data-scrolling")) el.setAttribute("data-scrolling", "");
      window.clearTimeout(timers.get(el));
      timers.set(el, window.setTimeout(() => el.removeAttribute("data-scrolling"), ms));
    };
    // (scroll doesn't bubble: caught on the way down, for every element)
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", onScroll, { capture: true });
  }, [ms]);
}
