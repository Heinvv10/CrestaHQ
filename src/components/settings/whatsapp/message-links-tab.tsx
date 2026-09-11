"use client";

import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { InlineConfirm } from "@/components/gbp/inline-confirm";
import { WA_PROFILE_LIMITS } from "@/lib/comms/whatsapp/settings/types";
import { errorOf, type WaMessageLink } from "./types";

/**
 * The Message Links tab: Meta's `message_qrdls` — create with a prefilled
 * text, copy the wa.me link, show its QR, delete. No edit (Meta has none).
 */

const MAX = WA_PROFILE_LIMITS.prefilledMessage;

function LinkRow({ link, isAdmin, onDelete }: { link: WaMessageLink; isAdmin: boolean; onDelete: () => Promise<void> }) {
  const [showQr, setShowQr] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(link.deepLinkUrl);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy — select the link and copy it manually.");
    }
  }
  return (
    <li className="space-y-2 rounded-lg border p-3" data-testid={`wa-link-row-${link.code}`}>
      <p className="text-sm">{link.prefilledMessage}</p>
      <p className="break-all font-mono text-xs text-muted-foreground" data-testid={`wa-link-url-${link.code}`}>
        {link.deepLinkUrl}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={copy} data-testid={`wa-link-copy-${link.code}`}>Copy</Button>
        {link.qrImageUrl && (
          <Button type="button" size="sm" variant="outline" onClick={() => setShowQr((v) => !v)} data-testid={`wa-link-qr-${link.code}`}>
            {showQr ? "Hide QR" : "Show QR"}
          </Button>
        )}
        {isAdmin && (
          <InlineConfirm label="Delete" confirmLabel="Delete link" prompt="Delete this link? Printed QR codes stop working." onConfirm={onDelete} testId={`wa-link-delete-${link.code}`} />
        )}
      </div>
      {showQr && link.qrImageUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- Meta CDN or a data URL
        <img src={link.qrImageUrl} alt="QR code" className="h-40 w-40 rounded bg-white p-1" data-testid={`wa-link-qr-img-${link.code}`} />
      )}
    </li>
  );
}

export function MessageLinksTab({ subAccountId, isAdmin }: { subAccountId: string; isAdmin: boolean }) {
  const base = `/api/sub-accounts/${subAccountId}/whatsapp/message-links`;
  const [links, setLinks] = useState<WaMessageLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [creating, setCreating] = useState(false);

  async function load() {
    setError(null);
    const res = await fetch(base).catch(() => null);
    if (!res?.ok) {
      setError(await errorOf(res, "Couldn't load message links from Meta."));
      return;
    }
    setLinks(((await res.json()) as { links: WaMessageLink[] }).links);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per sub-account
  }, [subAccountId]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefilledMessage: text.trim() }),
      }).catch(() => null);
      if (!res?.ok) {
        toast.error(await errorOf(res, "Couldn't create the link."));
        return;
      }
      const { link } = (await res.json()) as { link: WaMessageLink };
      setLinks((l) => [link, ...(l ?? [])]);
      setText("");
      toast.success("Message link created");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(code: string) {
    const res = await fetch(`${base}/${encodeURIComponent(code)}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) {
      toast.error(await errorOf(res, "Couldn't delete the link."));
      return;
    }
    setLinks((l) => (l ?? []).filter((x) => x.code !== code));
    toast.success("Link deleted");
  }

  if (error) {
    return (
      <div className="rounded-2xl border bg-card p-5 text-sm" data-testid="wa-links-error">
        <p className="text-rose-600 dark:text-rose-400">{error}</p>
        <Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => void load()}>Retry</Button>
      </div>
    );
  }
  if (!links) return <div className="h-40 animate-pulse rounded-2xl border bg-muted/30" data-testid="wa-links-loading" />;

  return (
    <div className="space-y-4">
      {isAdmin && (
        <form onSubmit={handleCreate} className="space-y-3 rounded-2xl border bg-card p-5">
          <div className="flex items-center justify-between">
            <Label htmlFor="wa-link-text">New message link</Label>
            <span className="text-[11px] text-muted-foreground">{text.length}/{MAX}</span>
          </div>
          <Textarea
            id="wa-link-text"
            rows={2}
            value={text}
            maxLength={MAX}
            placeholder="Hi! I'd like to know more about…"
            onChange={(e) => setText(e.target.value)}
            data-testid="wa-link-text"
          />
          <p className="text-xs text-muted-foreground">
            Customers who open the link or scan its QR code start a chat with this text already typed.
          </p>
          <div className="flex justify-end">
            <Button type="submit" disabled={!text.trim() || creating} data-testid="wa-link-create">
              {creating ? (<><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />Creating…</>) : "Create link"}
            </Button>
          </div>
        </form>
      )}

      {links.length === 0 ? (
        <p className="rounded-2xl border bg-card p-5 text-sm text-muted-foreground" data-testid="wa-links-empty">
          No message links yet. Create one to get a wa.me link and QR code customers can scan.
        </p>
      ) : (
        <ul className="space-y-3" data-testid="wa-links-list">
          {links.map((link) => (
            <LinkRow key={link.code} link={link} isAdmin={isAdmin} onDelete={() => handleDelete(link.code)} />
          ))}
        </ul>
      )}
    </div>
  );
}
