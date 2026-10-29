import "server-only";

import { execFile } from "node:child_process";
import { reverse } from "node:dns/promises";

import {
  addEntry, firewallStatus, removeEntry, setEnabled, type FirewallDeps, type FirewallResult, type FirewallStatus,
  type RunResult,
} from "@/lib/firewall-core";

// genie's egress firewall on this server: firewall-core.ts with the real runner
// (execFile, never a shell; the admin runs as genie, so root steps go through
// `sudo -n`) and real reverse DNS.

const EXEC_OPTS = { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 } as const;

function run(file: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, args, EXEC_OPTS, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && code === -1 ? err.message : "")) });
    });
  });
}

const deps: FirewallDeps = { run, reverse };

export const loadFirewallStatus = (): Promise<FirewallStatus> => firewallStatus(deps);
export const allowFirewallEntry = (entry: string): Promise<FirewallResult> => addEntry(deps, entry);
export const removeFirewallEntry = (entry: string): Promise<FirewallResult> => removeEntry(deps, entry);
export const setFirewallEnabled = (enabled: boolean): Promise<FirewallResult> => setEnabled(deps, enabled);
