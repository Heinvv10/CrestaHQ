"use client";

import { useMemo, useState } from "react";
import { Check, Copy, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { siteAddress, type WebsiteDoc } from "@/types/website";

/**
 * "Edit site" for a LIVE website. Editing happens in Claude with the GitPage
 * connector (MCP): gitpage invites the person who built the site as an
 * editor, so their Claude — signed in to gitpage with that email — can find
 * and edit it. One screen, three steps: connect once, copy the prompt (it
 * points Claude at THIS site and protects the CRM wiring), then chat.
 */

const MCP_URL = "https://www.gitpage.site/api/mcp";

/** A search term the GitPage MCP `search` tool matches (the repo name). */
function repoSearchTerm(liveUrl: string | null): string | null {
  if (!liveUrl) return null;
  try {
    const u = new URL(liveUrl);
    const seg = u.pathname.split("/").filter(Boolean)[0];
    if (seg) return seg;
    const label = u.hostname.split(".")[0];
    return label.replace(/-[0-9a-f]{6}$/i, "") || label;
  } catch {
    return null;
  }
}

export function buildEditPrompt(doc: WebsiteDoc): string {
  const title = doc.config.heading?.trim() || doc.name || "my website";
  const term = repoSearchTerm(doc.liveUrl);
  return [
    `Use the GitPage tools to edit my website "${title}".`,
    doc.gitpagePageId ? `GitPage pageId: ${doc.gitpagePageId}` : null,
    term ? `${doc.gitpagePageId ? "If that doesn't work, search" : "Find it with search"}: "${term}"` : null,
    siteAddress(doc) ? `Live site: ${siteAddress(doc)}` : null,
    "If you can't find the GitPage tools or this site, stop and tell me.",
    "",
    "Rules: don't change or remove the contact form, the chat widget script, or the site's styles and fonts. Show me a preview link first and only publish after I say yes.",
    "",
    "Once you've found the site, ask me what I'd like to change.",
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}

export function WebsiteEditHelper({
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
  const [copied, setCopied] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const prompt = useMemo(() => buildEditPrompt(doc), [doc]);

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1800);
    } catch {
      toast.error("Couldn't copy — select the text and copy it manually.");
    }
  }

  async function refreshKnowledge() {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/ai-agent/profile/refresh-kb`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: doc.id }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Couldn't update the chat bot.");
      toast.success("Chat bot updated from the live site.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update the chat bot.");
    } finally {
      setRefreshing(false);
    }
  }

  const account = doc.editorEmail
    ? <>sign in to gitpage with <span className="font-medium text-foreground">{doc.editorEmail}</span> (gitpage emailed you an invite)</>
    : <>sign in to gitpage with the account that owns this site</>;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <div className="border-b px-6 pb-4 pt-5">
          <DialogTitle className="text-base font-semibold">Edit this website</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            You edit your site by chatting with Claude. Claude shows you a preview before anything goes live.
          </DialogDescription>
        </div>

        <ol className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5 text-sm">
          <Step n={1} title="Connect GitPage to Claude (one time only)">
            <p className="text-xs text-muted-foreground">
              Already done this? Skip to step 2. Otherwise, in claude.ai or Claude Desktop go to Settings → Connectors → Add custom
              connector, paste this address, then {account}.
            </p>
            <CopyRow value={MCP_URL} copied={copied === "url"} onCopy={() => copy(MCP_URL, "url")} />
            <p className="text-[11px] text-muted-foreground">
              Using Claude Code instead? Run{" "}
              <button
                type="button"
                className="font-mono text-primary hover:underline"
                onClick={() => copy(`claude mcp add --transport http gitpage ${MCP_URL}`, "cli")}
              >
                {copied === "cli" ? "copied ✓" : "claude mcp add --transport http gitpage …"}
              </button>{" "}
              then type /mcp to sign in.
            </p>
          </Step>

          <Step n={2} title="Copy this prompt and paste it into a new Claude chat">
            <div className="relative">
              <pre className="whitespace-pre-wrap rounded-lg border bg-muted/30 p-3 pr-24 text-[11px] leading-relaxed">{prompt}</pre>
              <Button type="button" size="sm" className="absolute right-2 top-2" onClick={() => copy(prompt, "prompt")}>
                {copied === "prompt" ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
                {copied === "prompt" ? "Copied" : "Copy"}
              </Button>
            </div>
          </Step>

          <Step n={3} title="Tell Claude what to change">
            <p className="text-xs text-muted-foreground">
              Claude finds your site and asks what you&apos;d like changed — hours, prices, text, sections. It shows a preview link;
              say yes and it publishes.
            </p>
          </Step>
        </ol>

        <div className="flex items-center justify-between gap-3 border-t px-6 py-3">
          <p className="text-[11px] text-muted-foreground">Changed hours, prices or services? Update the chat bot afterwards.</p>
          <Button type="button" size="sm" variant="outline" onClick={refreshKnowledge} disabled={refreshing}>
            {refreshing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
            {refreshing ? "Updating…" : "Update chat bot"}
          </Button>
        </div>
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

function CopyRow({ value, copied, onCopy }: { value: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
      <code className="min-w-0 flex-1 truncate text-[11px]">{value}</code>
      <Button type="button" size="sm" variant="ghost" onClick={onCopy} aria-label="Copy">
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}
