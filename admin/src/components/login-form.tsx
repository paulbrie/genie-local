"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BASE_PATH } from "@/lib/config";
import { Lockup } from "@/components/brand/wisp";

/** What the Sign in with Genie callback sends back (?error=…), as shown: never why it failed. */
const GENIE_ERRORS: Record<string, string> = {
  not_allowed: "This Google account isn't allowed on this server",
  failed: "Signing in with Google didn't work. Try again, or use the emergency login.",
};

/**
 * The login card: "Sign in with Google" (through Genie) when this server is
 * set up for it, and the shared password form, the emergency login, always.
 */
export function LoginForm({ genie, genieError }: { genie: boolean; genieError: string | null }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const googleError = genieError ? (GENIE_ERRORS[genieError] ?? GENIE_ERRORS.failed) : null;
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? "Login failed");
        return;
      }
      // `next` is basePath-relative (e.g. /db). Guard against open redirects.
      const next = new URLSearchParams(window.location.search).get("next");
      const safe = next && next.startsWith("/") && !next.startsWith("//");
      window.location.assign(safe ? BASE_PATH + next : BASE_PATH);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center">
          {/* The stacked lockup: square spaces such as the login screen. */}
          <Lockup size={56} layout="stacked" motion="blink" className="mx-auto py-2" />
          <CardTitle className="sr-only">Spiridus · sign in</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {genie && (
            <div className="space-y-2">
              {/* A plain link: /start answers with a redirect to the genie manager. */}
              <a
                href={`${BASE_PATH}/api/auth/genie/start`}
                className="flex h-9 w-full items-center justify-center gap-2 rounded-md border bg-background text-sm font-medium transition-colors hover:bg-accent"
              >
                <GoogleMark />
                Sign in with Google
              </a>
              <p className="text-center text-xs text-muted-foreground">through Genie, for this server&apos;s users</p>
              {googleError && (
                <p role="alert" className="text-sm text-destructive">
                  {googleError}
                </p>
              )}
            </div>
          )}
          {genie && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              Emergency login
              <span className="h-px flex-1 bg-border" />
            </div>
          )}
          {!genie && googleError && (
            <p role="alert" className="text-sm text-destructive">
              {googleError}
            </p>
          )}
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                name="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" variant={genie ? "outline" : "default"} className="w-full" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

/** Google's "G", in its colours. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="size-4" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}
