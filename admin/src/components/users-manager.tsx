"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { addUserAction, removeUserAction, setUserEnabledAction } from "@/app/users/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AdminUser } from "@/db/schema";
import { confirmDialog } from "@/lib/ask";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

/** The Users page: add a person (email + name), enable / disable, remove. */
export function UsersManager({ users }: { users: AdminUser[] }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [isPending, startTransition] = useTransition();

  function add(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await addUserAction({ email, name });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Added ${email.trim().toLowerCase()}`);
      setEmail("");
      setName("");
    });
  }

  function toggle(u: AdminUser) {
    startTransition(async () => {
      await setUserEnabledAction(u.id, !u.enabled);
      toast.success(`${u.enabled ? "Disabled" : "Enabled"} ${u.email}`);
    });
  }

  async function remove(u: AdminUser) {
    if (
      !(await confirmDialog(`Remove ${u.email}? They won't be able to sign in with Google here.`, {
        title: "Remove this user?",
        confirmLabel: "Remove",
        destructive: true,
      }))
    ) {
      return;
    }
    startTransition(async () => {
      await removeUserAction(u.id);
      toast.success(`Removed ${u.email}`);
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent>
          <form onSubmit={add} className="flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1 space-y-1">
              <Label htmlFor="user-email">Google account email</Label>
              <Input
                id="user-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                autoComplete="off"
                required
              />
            </div>
            <div className="min-w-44 flex-1 space-y-1">
              <Label htmlFor="user-name">Name</Label>
              <Input id="user-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" required />
            </div>
            <Button type="submit" disabled={isPending}>
              <Plus className="size-4" /> Add
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          {users.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No users yet: nobody can sign in with Google here until you add them.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Last login</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <TableRow key={u.id} className={u.enabled ? undefined : "text-muted-foreground"}>
                    <TableCell className="text-xs">{u.email}</TableCell>
                    <TableCell>{u.name}</TableCell>
                    <TableCell>
                      {u.enabled ? (
                        <span className="font-medium text-emerald-700 dark:text-emerald-400">Enabled</span>
                      ) : (
                        <span>Disabled</span>
                      )}
                    </TableCell>
                    <TableCell title={u.lastLoginAt ? formatDateTime(u.lastLoginAt) : undefined}>
                      {u.lastLoginAt ? formatRelativeTime(u.lastLoginAt) : "never"}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button size="sm" variant="outline" disabled={isPending} onClick={() => toggle(u)}>
                        {u.enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-1"
                        disabled={isPending}
                        onClick={() => void remove(u)}
                        aria-label={`Remove ${u.email}`}
                        title="Remove"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
