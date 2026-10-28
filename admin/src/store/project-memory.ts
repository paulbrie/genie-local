"use client";

import { Subject } from "subjecto";

import type { ProjectMemory, ProjectMemoryStatus } from "@/lib/project-memory";

/**
 * The latest /api/project-memory reading, kept fresh by <ProjectMemoryMonitor>
 * in the root layout: the top bar, the sidebar and the project pages read it
 * rather than each polling. Null until the first answer.
 */
export const projectMemory = new Subject<ProjectMemoryStatus | null>(null, { name: "projectMemory" });

/** A project's entry in a reading (nothing running = absent). */
export function memoryOf(status: ProjectMemoryStatus | null, slug: string): ProjectMemory | null {
  return status?.projects.find((p) => p.slug === slug) ?? null;
}
