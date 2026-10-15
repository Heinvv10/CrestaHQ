"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/**
 * "Save as template" for a live site: it becomes one of the agency's gitpage
 * Agency templates, which the wizard can then build from (Agency template
 * tile). The agency owner saves for every client, or for this client only;
 * the client's own admins save templates only this client builds from. The
 * site itself stays exactly as it is.
 */
export function SaveTemplateDialog({
  open,
  onOpenChange,
  subAccountId,
  siteId,
  defaultName,
  isTemplate,
  scope = null,
  asOwner = false,
  canChooseClient = false,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subAccountId: string;
  siteId: string;
  /** Pre-filled name (the template's current name, else the site's). */
  defaultName: string;
  isTemplate: boolean;
  /** Current scope when it already is a template. */
  scope?: "agency" | "client" | null;
  /** The agency owner (chooses the scope); otherwise the client's admin. */
  asOwner?: boolean;
  /** gitpage knows client templates (the owner's "Only this client" option). */
  canChooseClient?: boolean;
  onChanged: () => void;
}) {
  const [name, setName] = useState(defaultName);
  const [clientOnly, setClientOnly] = useState(scope === "client");
  const [busy, setBusy] = useState<"" | "save" | "remove">("");

  useEffect(() => {
    if (open) {
      setName(defaultName.slice(0, 60));
      setClientOnly(scope === "client");
    }
  }, [open, defaultName, scope]);

  async function call(method: "POST" | "DELETE") {
    setBusy(method === "POST" ? "save" : "remove");
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/website/${siteId}/template`, {
        method,
        headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
        body:
          method === "POST"
            ? JSON.stringify(
                asOwner && canChooseClient ? { name: name.trim(), scope: clientOnly ? "client" : "agency" } : { name: name.trim() },
              )
            : undefined,
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Something went wrong.");
      toast.success(method === "DELETE" ? "Removed from templates" : isTemplate ? "Template updated" : "Saved as a template");
      onChanged();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy("");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full gap-0 p-0 sm:max-w-lg">
        <div className="border-b px-6 pb-4 pt-5">
          <DialogTitle className="text-base font-semibold">{isTemplate ? "Edit template" : "Save as template"}</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {asOwner
              ? "Build new client sites from this one: pick it under Agency template when you build a website."
              : "Build new websites for this business from this one: pick it under Agency template when you add a website."}
          </DialogDescription>
        </div>
        <form
          className="space-y-4 px-6 py-5 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && !busy) void call("POST");
          }}
        >
          <div className="space-y-1.5">
            <label htmlFor="template-name" className="text-xs font-medium">Template name</label>
            <Input id="template-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Plumber – dark premium" />
          </div>
          {asOwner ? (
            canChooseClient && <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" className="mt-0.5" checked={clientOnly} onChange={(e) => setClientOnly(e.target.checked)} />
              <span>
                <span className="font-medium">Only this client</span> — offer it to this sub-account only, not to your other clients.
              </span>
            </label>
          ) : (
            <p className="text-xs text-muted-foreground">Only this business&apos;s websites can be built from it — your agency&apos;s other clients won&apos;t see it.</p>
          )}
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-300">
            New sites get this design and pages with their own business name, contact details, address and contact form.
            Opening hours, team, testimonials and photos are copied as they are — use a site without client-specific
            content. Later edits to this site change what new builds start from.
          </div>
          <div className="flex items-center justify-between gap-2 pt-1">
            {isTemplate ? (
              <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => void call("DELETE")} disabled={!!busy}>
                {busy === "remove" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                Remove from templates
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={!!busy}>Cancel</Button>
              <Button type="submit" size="sm" disabled={!name.trim() || !!busy}>
                {busy === "save" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                {isTemplate ? "Save changes" : "Save as template"}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
