import Link from "next/link";

import { AutoRefresh } from "@/components/auto-refresh";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  failuresLastDay,
  LOGIN_FAILURES,
  recentLogins,
  recentSessions,
  type LoginFailure,
} from "@/lib/admin-auth-log";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { describeUserAgent } from "@/lib/user-agent";

export const dynamic = "force-dynamic";

const reasonText = (r: string | null) =>
  r && r in LOGIN_FAILURES ? LOGIN_FAILURES[r as LoginFailure] : (r ?? "");

/** /logins: admin sessions (who is connected, from where) and every login attempt with why it failed. */
export default async function LoginsPage({
  searchParams,
}: {
  searchParams: Promise<{ failed?: string }>;
}) {
  const failedOnly = (await searchParams).failed === "1";
  const [logins, sessions, failures] = await Promise.all([
    recentLogins({ failedOnly }),
    recentSessions(7),
    failuresLastDay(),
  ]);
  const failedTotal = failures.reduce((n, f) => n + f.n, 0);

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Logins</h1>
        <p className="text-sm text-muted-foreground">
          Who is signed in to the admin, from where, and every login attempt with the reason a failed one failed.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            Failed logins, last 24 h: <span className="tabular-nums">{failedTotal}</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {failedTotal === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <ul className="flex flex-wrap gap-2 text-sm">
              {failures.map((f) => (
                <li key={f.reason ?? "?"} className="rounded-md border px-2 py-1">
                  <span className="font-medium tabular-nums">{f.n}</span> · {reasonText(f.reason)}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Sessions, last 7 days</CardTitle>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sessions recorded yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>State</TableHead>
                  <TableHead>Browser</TableHead>
                  <TableHead>IP</TableHead>
                  <TableHead>Signed in</TableHead>
                  <TableHead>Last seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((s) => {
                  const { state } = s;
                  return (
                    <TableRow key={s.id}>
                      <TableCell className={state === "Connected" ? "font-medium text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}>
                        {state}
                      </TableCell>
                      <TableCell title={s.userAgent ?? undefined}>
                        {describeUserAgent(s.userAgent)}
                        {s.via === "token" && (
                          <span
                            className="ml-1.5 rounded bg-muted px-1 text-[10px] text-muted-foreground"
                            title="Its cookie wasn't issued by the login form here (an older login, or a token from npm run session)"
                          >
                            token
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{s.ip}</TableCell>
                      <TableCell title={formatDateTime(s.createdAt)}>{formatRelativeTime(s.createdAt)}</TableCell>
                      <TableCell title={formatDateTime(s.lastSeenAt)}>
                        {s.endedAt ? `out ${formatRelativeTime(s.endedAt)}` : formatRelativeTime(s.lastSeenAt)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm">Login log</CardTitle>
          <nav className="flex gap-1 text-xs">
            <Link
              href="/logins"
              className={`rounded-md px-2 py-1 ${!failedOnly ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/50"}`}
            >
              All
            </Link>
            <Link
              href="/logins?failed=1"
              className={`rounded-md px-2 py-1 ${failedOnly ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/50"}`}
            >
              Failed
            </Link>
          </nav>
        </CardHeader>
        <CardContent>
          {logins.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {failedOnly ? "No failed logins recorded." : "No logins recorded yet."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead>Username</TableHead>
                  <TableHead>IP</TableHead>
                  <TableHead>Browser</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logins.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell title={formatDateTime(l.at)} className="whitespace-nowrap">
                      {formatRelativeTime(l.at)}
                    </TableCell>
                    <TableCell>
                      {l.event === "logout" ? (
                        <span className="text-muted-foreground">Logged out</span>
                      ) : l.ok ? (
                        <span className="font-medium text-emerald-700 dark:text-emerald-400">Signed in</span>
                      ) : (
                        <span>
                          <span className="font-medium text-red-700 dark:text-red-400">Failed</span>
                          <span className="text-muted-foreground"> · {reasonText(l.reason)}</span>
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{l.username ?? ""}</TableCell>
                    <TableCell className="font-mono text-xs">{l.ip}</TableCell>
                    <TableCell title={l.userAgent ?? undefined}>{describeUserAgent(l.userAgent)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <AutoRefresh ms={20_000} />
    </main>
  );
}
