// Types for clean-env.mjs (plain JS so server/pty.mjs can import it).

export function keepEnvKey(key: string): boolean;
/** (Typed as a ProcessEnv to go straight to spawn/execFile: there's no NODE_ENV in it, by design.) */
export function cleanEnv(env?: Record<string, string | undefined>, extra?: Record<string, string>): NodeJS.ProcessEnv;
export function staleTmuxEnvKeys(keys: string[], adminEnv?: Record<string, string | undefined>): string[];
