import "server-only";

import { cache } from "react";

import { getProjectDetail } from "@/lib/scan";

/**
 * The project's row and apps, once per request: the project layout (header,
 * tab bar) and the tab page both need it.
 */
export const getProject = cache(getProjectDetail);

export const PROJECT_TABS = ["scripts", "tasks", "notes", "memory", "git"] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];
