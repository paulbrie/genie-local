import "server-only";

import { and, desc, eq, isNull } from "drizzle-orm";

import { db } from "@/db";
import { browserLinks } from "@/db/schema";

/** A tab the extension shares with Spiridus, as it reports them. */
export type BrowserTab = {
  id: number;
  windowId: number;
  url: string;
  title: string;
  active: boolean;
  /** Opened by Spiridus (rather than shared by its user). */
  opened?: boolean;
  /** chrome.debugger is attached to it. */
  attached?: boolean;
};

type Live = {
  id: number;
  name: string;
  online: true;
  connectedAt: number;
  ip: string;
  info: Record<string, string | undefined>;
  tabs: BrowserTab[];
  unsharedTabs: number;
};

export type BridgeEvent = { seq: number; at: number; kind: string; tabId?: number; data?: unknown };

/** What the browser bridge in server.mjs (server/browser-bridge.mjs) exposes to route handlers (same process). */
type Hub = {
  createPairCode(createdBy: string | null): { code: string; expiresAt: number };
  connected(): Live[];
  get(id: number): Live | null;
  command(id: number, type: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  events(id: number, after?: number, waitMs?: number): Promise<{ seq: number; events: BridgeEvent[] }>;
  disconnect(id: number): boolean;
};

/** Null when Next runs without the custom server (e.g. a bare `next dev`). */
export function browserBridge(): Hub | null {
  return (globalThis as { __browserBridge?: Hub }).__browserBridge ?? null;
}

export type BrowserSummary = {
  id: number;
  name: string;
  createdBy: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
  info: Record<string, string | undefined>;
  online: boolean;
  connectedAt: number | null;
  tabs: BrowserTab[];
  unsharedTabs: number;
};

/** Every paired (not revoked) browser, connected ones first. */
export async function listBrowsers(): Promise<BrowserSummary[]> {
  const rows = await db
    .select()
    .from(browserLinks)
    .where(isNull(browserLinks.revokedAt))
    .orderBy(desc(browserLinks.lastSeenAt), desc(browserLinks.id));
  const live = new Map((browserBridge()?.connected() ?? []).map((b) => [b.id, b]));
  return rows
    .map((r) => {
      const l = live.get(r.id);
      return {
        id: r.id,
        name: r.name,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        lastSeenAt: r.lastSeenAt,
        info: (l?.info ?? r.info ?? {}) as Record<string, string | undefined>,
        online: !!l,
        connectedAt: l?.connectedAt ?? null,
        tabs: l?.tabs ?? [],
        unsharedTabs: l?.unsharedTabs ?? 0,
      };
    })
    .sort((a, b) => Number(b.online) - Number(a.online));
}

export async function renameBrowser(id: number, name: string): Promise<boolean> {
  const rows = await db
    .update(browserLinks)
    .set({ name })
    .where(and(eq(browserLinks.id, id), isNull(browserLinks.revokedAt)))
    .returning({ id: browserLinks.id });
  return rows.length > 0;
}

/** Unpair: the token stops working and the socket, if any, is dropped. */
export async function revokeBrowser(id: number): Promise<boolean> {
  const rows = await db
    .update(browserLinks)
    .set({ revokedAt: new Date() })
    .where(and(eq(browserLinks.id, id), isNull(browserLinks.revokedAt)))
    .returning({ id: browserLinks.id });
  browserBridge()?.disconnect(id);
  return rows.length > 0;
}

export function parseBrowserId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
