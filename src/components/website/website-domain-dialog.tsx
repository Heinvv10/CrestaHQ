"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { WebsiteDoc } from "@/types/website";

/**
 * "Custom domain" for a live site. The domain itself is set up in GitLab
 * (or GitHub); saving it here keeps LeadStack in step: the chat widget is
 * allow-listed on it, the card and "Update chat bot" use it, and a ready
 * Claude prompt fixes the site's canonical links + sitemap for SEO.
 */

function seoPrompt(doc: WebsiteDoc, domain: string): string {
  const title = doc.config.heading?.trim() || doc.name || "my website";
  return [
    `Use the GitPage tools to update my website "${title}" for its new custom domain.`,
    doc.gitpagePageId ? `GitPage pageId: ${doc.gitpagePageId}` : null,
    doc.liveUrl ? `Current address: ${doc.liveUrl}` : null,
    `New address: https://${domain}/`,
    "",
    `1. On every page, change the canonical link, og:url and any JSON-LD "url" values from the current address to https://${domain}/ (keep the page paths).`,
    `2. Run generate_sitemap, generate_robots_txt and generate_llms_txt with customDomain "${domain}".`,
    "Don't change anything else. Show me the preview, then publish after I say yes.",
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}

export function WebsiteDomainDialog({
  open,
  onOpenChange,
  subAccountId,
  doc,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subAccountId: string;
  doc: WebsiteDoc;
}) {
  const [value, setValue] = useState(doc.customDomain ?? "");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) setValue(doc.customDomain ?? "");
  }, [open, doc.customDomain]);

  const saved = doc.customDomain ?? null;
  const isGithub = (doc.liveUrl ?? "").includes("github.io");

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/website/${doc.id}/domain`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: value }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Couldn't save the domain.");
      toast.success("Domain saved — the chat bubble will now show on it.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save the domain.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/website/${doc.id}/domain`, { method: "DELETE" });
      if (!res.ok) throw new Error("Couldn't remove the domain.");
      setValue("");
      toast.success("Custom domain removed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove the domain.");
    } finally {
      setSaving(false);
    }
  }

  async function copyPrompt() {
    if (!saved) return;
    try {
      await navigator.clipboard.writeText(seoPrompt(doc, saved));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Couldn't copy — select the text and copy it manually.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <div className="border-b px-6 pb-4 pt-5">
          <DialogTitle className="text-base font-semibold">Custom domain</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Use your own address, like www.yourbusiness.com, instead of the {isGithub ? "github.io" : "gitlab.io"} one.
          </DialogDescription>
        </div>

        <ol className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5 text-sm">
          <Step n={1} title={`Connect the domain in ${isGithub ? "GitHub" : "GitLab"}`}>
            {isGithub ? (
              <p className="text-xs text-muted-foreground">
                In the repository go to Settings → Pages → Custom domain, enter your domain, add the DNS records GitHub shows at
                your domain provider, and tick Enforce HTTPS once it&apos;s verified.
              </p>
            ) : (
              <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                <li>In the project go to Deploy → Pages → New domain, enter your domain and add the DNS records GitLab shows at your domain provider.</li>
                <li>Once it&apos;s verified, set it as the <span className="font-medium text-foreground">Primary domain</span>, so the old address redirects to it.</li>
                <li>Untick <span className="font-medium text-foreground">Use unique domain</span> — otherwise visitors can be sent back to the gitlab.io address.</li>
              </ul>
            )}
          </Step>

          <Step n={2} title="Tell LeadStack the domain">
            <div className="flex gap-2">
              <Input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="www.yourbusiness.com"
                aria-label="Custom domain"
              />
              <Button type="button" onClick={save} disabled={saving || !value.trim() || value.trim() === saved}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              This lets the chat bubble appear on your domain and points the chat bot at it.
              {saved && (
                <>
                  {" "}
                  <button type="button" onClick={remove} disabled={saving} className="text-rose-600 hover:underline">
                    Remove domain
                  </button>
                </>
              )}
            </p>
          </Step>

          <Step n={3} title="Update the site's links for search engines">
            <p className="text-xs text-muted-foreground">
              The site still tells Google its address is the old one. Paste this into Claude (with the GitPage connector) to fix the
              links and sitemap.
            </p>
            <Button type="button" size="sm" variant="outline" onClick={copyPrompt} disabled={!saved}>
              {copied ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
              {copied ? "Copied" : saved ? "Copy prompt" : "Save the domain first"}
            </Button>
          </Step>
        </ol>
      </DialogContent>
    </Dialog>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="font-medium">{title}</p>
        {children}
      </div>
    </li>
  );
}
