// Types for activity-core.mjs (kept as plain JS so the raw-Node PTY bridge can import it).

export type ActivityEvent =
  | "page.view"
  | "action"
  | "terminal.attach"
  | "terminal.detach"
  | "auth.login"
  | "auth.logout"
  | "auth.failed";

export type PropValue = string | number | boolean | null;
export type ActivityProps = Record<string, PropValue>;

export type ActivityContext = {
  /** admin_sessions.id (sessionIdOf of a verified cookie), null when not signed in. */
  session?: string | null;
  /** The raw client IP: only its keyed hash is written. */
  ip?: string | null;
  /** The raw User-Agent header: only "<browser> on <OS>" is written. */
  ua?: string | null;
  props?: Record<string, unknown>;
};

export type ActivityLine = {
  v: 1;
  id: string;
  ts: number;
  event: ActivityEvent;
  session: string | null;
  ipHash: string | null;
  ua: string | null;
  props: ActivityProps;
};

export const LINE_VERSION: 1;
export const DEFAULT_SPOOL: string;
export const SPOOL_MAX_BYTES: number;
export const MAX_PROPS: number;
export const MAX_STRING: number;
export const EVENT_PROPS: Record<ActivityEvent, Record<string, (v: unknown) => boolean>>;

export function spoolPath(): string;
export function sessionIdOf(token: string): string;
export function clientIpOf(realIp: string | null | undefined, forwardedFor: string | null | undefined): string | null;
export function hashIp(ip: string | null | undefined, appEncKey?: string): string | null;
export function uaFamily(ua: string | null | undefined): string | null;
export function isActivityEvent(event: unknown): event is ActivityEvent;
export function sanitizeProps(props: unknown): ActivityProps;
export function propsFor(event: string, props: unknown): ActivityProps;
export function buildLine(event: string, ctx?: ActivityContext, now?: number): string | null;
export function appendLine(line: string, file?: string): Promise<boolean>;
export function recordActivity(event: ActivityEvent, ctx?: ActivityContext, file?: string): Promise<boolean>;
