"use client";

import Link from "next/link";
import { useRouter, useSelectedLayoutSegment } from "next/navigation";
import { useEffect } from "react";

const storageKey = (slug: string) => `admin:project-tab:${slug}`;

/**
 * The project's tabs as links (/projects/<slug>/scripts, /tasks, /notes,
 * /git), styled like the tab list. The tab in use is remembered per project so
 * /projects/<slug> reopens it (ProjectTabRedirect).
 */
export function ProjectTabNav({
  slug,
  tabs,
}: {
  slug: string;
  tabs: { id: string; label: string }[];
}) {
  const segment = useSelectedLayoutSegment();
  const active = tabs.some((t) => t.id === segment) ? segment : null;

  useEffect(() => {
    if (!active) return;
    try {
      localStorage.setItem(storageKey(slug), active);
    } catch {
      /* storage blocked: the tab just isn't remembered */
    }
  }, [slug, active]);

  return (
    <nav
      aria-label="Project sections"
      className="inline-flex h-8 w-fit items-center rounded-lg bg-muted p-[3px] text-muted-foreground"
    >
      {tabs.map((t) => (
        <Link
          key={t.id}
          href={`/projects/${encodeURIComponent(slug)}/${t.id}`}
          aria-current={t.id === active ? "page" : undefined}
          className={`inline-flex h-full items-center rounded-md px-2 text-sm font-medium whitespace-nowrap transition-colors hover:text-foreground ${
            t.id === active ? "bg-background text-foreground shadow-sm" : ""
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/** /projects/<slug>: go to the tab used last on this project (Scripts at first). */
export function ProjectTabRedirect({ slug, tabs }: { slug: string; tabs: string[] }) {
  const router = useRouter();
  useEffect(() => {
    let tab: string | null = null;
    try {
      tab = localStorage.getItem(storageKey(slug));
    } catch {
      /* storage blocked */
    }
    router.replace(
      `/projects/${encodeURIComponent(slug)}/${tab && tabs.includes(tab) ? tab : tabs[0]}`,
    );
  }, [router, slug, tabs]);
  return null;
}
