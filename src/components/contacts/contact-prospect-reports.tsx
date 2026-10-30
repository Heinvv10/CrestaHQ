"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FileSearch, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { useSubAccount } from "@/context/sub-account-context";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ContactMysteryShop } from "@/components/contacts/contact-mystery-shop";

/**
 * Prospect reports for one contact, on the contact profile. Renders nothing
 * unless the agency has Prospecting on for this sub-account. Generate queues
 * a report against the monthly quota; the list polls every few seconds while
 * a report is queued or running. Share mints a public link — shown once,
 * here, and copied — and Revoke kills it.
 */

type ReportRow = {
  id: string;
  status: "queued" | "running" | "ready" | "failed";
  headline: string | null;
  shared: boolean;
  createdAt: string | null;
};

type ListResponse = { reports: ReportRow[]; quota: number; used: number };

export const POLL_MS = 4000;

const STATUS_BADGE: Record<ReportRow["status"], { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  queued: { label: "Queued", variant: "outline" },
  running: { label: "Running", variant: "secondary" },
  ready: { label: "Ready", variant: "default" },
  failed: { label: "Failed", variant: "destructive" },
};

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (body.code === "quota_exhausted") return "This month's report quota is used up.";
  if (body.code === "gate_off") return "Prospecting is locked by your agency.";
  if (body.code === "report_in_progress") return "A report for this contact is already running.";
  return body.error ?? `Failed (HTTP ${res.status})`;
}

export function ContactProspectReports({ contactId }: { contactId: string }) {
  const { subAccount, subAccountId, saPath } = useSubAccount();
  const enabled = subAccount?.prospectingEnabledByAgency === true;
  const base = `/api/sub-accounts/${subAccountId}/prospecting/reports`;

  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sharedUrl, setSharedUrl] = useState<{ id: string; url: string } | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${base}?contactId=${encodeURIComponent(contactId)}`);
      if (!res.ok) throw new Error(await errorOf(res));
      setData((await res.json()) as ListResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load reports");
    }
  }, [base, contactId]);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  const pending = !!data?.reports.some((r) => r.status === "queued" || r.status === "running");
  useEffect(() => {
    if (!enabled || !pending) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [enabled, pending, load]);

  if (!enabled) return null;

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  };

  const generate = () =>
    run("generate", async () => {
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId }),
      });
      if (!res.ok) throw new Error(await errorOf(res));
      await load();
    });

  const share = (id: string) =>
    run(id, async () => {
      const res = await fetch(`${base}/${id}/share`, { method: "POST" });
      if (!res.ok) throw new Error(await errorOf(res));
      const { url } = (await res.json()) as { url: string };
      setSharedUrl({ id, url });
      try {
        await navigator.clipboard.writeText(url);
        toast.success("Share link copied");
      } catch {
        toast.message("Copy the share link from the card");
      }
      await load();
    });

  const revoke = (id: string) =>
    run(id, async () => {
      const res = await fetch(`${base}/${id}/share`, { method: "DELETE" });
      if (!res.ok) throw new Error(await errorOf(res));
      setSharedUrl((s) => (s?.id === id ? null : s));
      await load();
    });

  const atQuota = !!data && data.used >= data.quota;

  return (
    <Card className="space-y-3 p-5" data-testid="contact-prospect-reports">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <FileSearch className="h-4 w-4" />
          Prospect reports
        </h2>
        <Button
          type="button"
          size="sm"
          onClick={() => void generate()}
          disabled={!data || atQuota || busy !== null}
          data-testid="prospect-report-generate"
        >
          {busy === "generate" && <Loader2 className="h-4 w-4 animate-spin" />}
          Generate report
        </Button>
      </div>
      {data && (
        <p className="text-xs text-muted-foreground" data-testid="prospect-report-quota">
          {data.used} of {data.quota} reports used this month
          {atQuota ? " — the quota is used up until next month." : ""}
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {data?.reports.length === 0 && (
        <p className="text-xs text-muted-foreground">No reports for this contact yet.</p>
      )}
      {data?.reports.map((r) => (
        <div key={r.id} className="space-y-2 rounded-md border p-3" data-testid={`prospect-report-${r.id}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {r.createdAt ? new Date(r.createdAt).toLocaleString() : "Just now"}
            </p>
            <div className="flex items-center gap-2">
              {r.shared && <Badge variant="outline">Shared</Badge>}
              <Badge variant={STATUS_BADGE[r.status]?.variant ?? "outline"}>
                {STATUS_BADGE[r.status]?.label ?? r.status}
              </Badge>
            </div>
          </div>
          {r.status === "ready" && (
            <>
              {r.headline && <p className="text-sm font-medium">{r.headline}</p>}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  render={<Link href={saPath(`/prospecting/reports/${r.id}`)} />}
                >
                  View
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void share(r.id)}
                  disabled={busy !== null}
                >
                  {busy === r.id && <Loader2 className="h-4 w-4 animate-spin" />}
                  {r.shared ? "New share link" : "Share"}
                </Button>
                {r.shared && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setRevokeId(r.id)}
                    disabled={busy !== null}
                  >
                    Revoke link
                  </Button>
                )}
              </div>
              {sharedUrl?.id === r.id && (
                <p className="break-all rounded bg-muted px-2 py-1 text-xs" data-testid="prospect-report-share-url">
                  {sharedUrl.url}
                  <span className="block text-muted-foreground">
                    Shown once — copy it now. A new link replaces this one.
                  </span>
                </p>
              )}
            </>
          )}
        </div>
      ))}

      <ContactMysteryShop contactId={contactId} />

      <AlertDialog open={revokeId !== null} onOpenChange={(open) => !open && setRevokeId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke the share link?</AlertDialogTitle>
            <AlertDialogDescription>
              Anyone opening the link will get a &ldquo;not found&rdquo; page. You can share the
              report again with a new link.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const id = revokeId;
                setRevokeId(null);
                if (id) void revoke(id);
              }}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
