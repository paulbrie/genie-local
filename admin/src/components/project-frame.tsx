"use client";

import { useSelectedLayoutSegments } from "next/navigation";

/**
 * The project page's frame: the usual reading width, but the whole window for
 * a commit (/git/<hash>), where diffs need the room.
 */
export function ProjectFrame({ children }: { children: React.ReactNode }) {
  const segments = useSelectedLayoutSegments();
  const wide = segments[0] === "git" && segments.length > 1;
  return (
    <main className={`mx-auto w-full flex-1 space-y-6 p-6 ${wide ? "max-w-none" : "max-w-5xl"}`}>
      {children}
    </main>
  );
}
