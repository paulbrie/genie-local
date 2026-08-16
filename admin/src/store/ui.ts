"use client";

import { Subject } from "subjecto";

export type ViewMode = "grid" | "list";

/**
 * Ephemeral client-side UI state, held outside React via `subjecto`.
 * Server data stays in RSC/DB — these subjects only drive presentation.
 */
export const viewMode = new Subject<ViewMode>("grid", { name: "viewMode" });
export const search = new Subject<string>("", { name: "search" });
export const busy = new Subject<boolean>(false, { name: "busy" });
