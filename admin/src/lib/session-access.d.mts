// Types for session-access.mjs (plain JS so server/pty.mjs can import it).

export const ACCESS_TTL_MS: number;
export function subjectAllowed(sub: string | null | undefined, opts?: { lookup?: (email: string) => Promise<boolean>; now?: number }): Promise<boolean>;
export function clearUserAccess(email?: string | null): void;
