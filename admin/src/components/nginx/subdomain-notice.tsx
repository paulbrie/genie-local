"use client";

import { useState } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * "Add a subdomain route" (T242), not set up yet: Nginx has one server block
 * (listen 3000, any host), and the generated include sits inside it, where a
 * subdomain's own server block can't go. It needs a one-time root change (an
 * http-level include of a second generated file) and the cloud gateway routing
 * the subdomain here (TLS ends there): the user's call. Until then, this says so.
 */
export function SubdomainNotice({ enabled }: { enabled: boolean }) {
  const [open, setOpen] = useState(false);
  if (enabled) return null;
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" aria-hidden /> Subdomain route
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Subdomain routes aren&rsquo;t set up yet</DialogTitle>
            <DialogDescription>
              Every route today lives in one server block (port 3000, any host name). The admin writes only the generated{" "}
              <code className="font-mono text-xs">projects.conf</code>, which Nginx includes <em>inside</em> that block, so a
              subdomain&rsquo;s own server block can&rsquo;t go there.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p>To map a subdomain to an app, two things are needed first:</p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                A one-time root change: Nginx includes a second admin-generated file at the <code className="font-mono text-xs">http</code> level
                (e.g. <code className="font-mono text-xs">/etc/nginx/conf.d/ft-subdomains.conf</code> →{" "}
                <code className="font-mono text-xs">/opt/project/admin/nginx/subdomains.conf</code>).
              </li>
              <li>The cloud gateway in front of this box sends that subdomain here, and holds its TLS certificate (TLS ends there).</li>
            </ol>
            <p className="text-muted-foreground">Both are the owner&rsquo;s call. Once they&rsquo;re done, subdomains get set here like ports, with the same preview and rollback.</p>
          </div>
          <DialogFooter>
            <Button onClick={() => setOpen(false)}>OK</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
