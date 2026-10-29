import { FirewallManager } from "@/components/firewall-manager";
import { requireAdmin } from "@/lib/require-admin";

export const dynamic = "force-dynamic";

/** /firewall: genie's egress firewall for this server — where Claude sessions and dev servers may connect. */
export default async function FirewallPage() {
  await requireAdmin();
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 space-y-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Firewall</h1>
        <p className="text-sm text-muted-foreground">
          genie&apos;s egress firewall: outbound traffic from the <code className="font-mono text-xs">genie</code>{" "}
          user (every Claude session and dev server on this box) may only reach the allowlist below. Loopback, DNS and
          private ranges are always open; root and other users aren&apos;t filtered. The same controls as the Claude
          egress section of this server&apos;s card in genie.
        </p>
      </header>
      <FirewallManager />
    </main>
  );
}
