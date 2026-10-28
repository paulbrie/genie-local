import { UsersManager } from "@/components/users-manager";
import { listUsers } from "@/lib/admin-users";
import { genieIdentity } from "@/lib/genie-sso";

export const dynamic = "force-dynamic";

/** /users: the local accounts, who may Sign in with Genie on this server. */
export default async function UsersPage() {
  const users = await listUsers();
  const configured = genieIdentity() !== null;
  return (
    <main className="mx-auto w-full max-w-4xl flex-1 space-y-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
        <p className="text-sm text-muted-foreground">
          Who may sign in here with Google, through Genie: the person must be a member of this server&apos;s genie
          project (Genie checks) and enabled on this list (this server checks). The shared password login is the
          emergency login and doesn&apos;t use this list.
        </p>
        {!configured && (
          <p className="mt-2 rounded-md border px-3 py-2 text-sm text-muted-foreground">
            Sign in with Genie isn&apos;t set up on this server yet (no /opt/project/.genie-instance.json, which the
            genie manager writes), so the login page shows only the password login for now.
          </p>
        )}
      </header>
      <UsersManager users={users} />
    </main>
  );
}
