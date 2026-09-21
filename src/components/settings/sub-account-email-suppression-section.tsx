"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { EmailSuppressionReason } from "@/types/email";

interface Item {
  email: string;
  reason: EmailSuppressionReason;
  note: string | null;
  createdAt: string | null;
}

const REASONS: { value: EmailSuppressionReason; label: string }[] = [
  { value: "manual", label: "Do not email" },
  { value: "hard_bounce", label: "Hard bounce" },
  { value: "complaint", label: "Spam complaint" },
];

export function SubAccountEmailSuppressionSection() {
  const { subAccountId, isAdmin } = useSubAccount();
  return isAdmin ? <SuppressionList key={subAccountId} subAccountId={subAccountId} /> : null;
}

function SuppressionList({ subAccountId }: { subAccountId: string }) {
  const url = `/api/sub-accounts/${subAccountId}/email-suppressions`;
  const [items, setItems] = useState<Item[] | null>(null);
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState<EmailSuppressionReason>("manual");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Unable to load the suppression list.");
    setItems(data.items);
  }, [url]);

  useEffect(() => {
    load().catch((err) =>
      setError(err instanceof Error ? err.message : "Unable to load the suppression list.")
    );
  }, [load]);

  async function run(request: () => Promise<Response>) {
    setBusy(true);
    setError("");
    try {
      const res = await request();
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status}).`);
      await load();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    const ok = await run(() =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, reason }),
      })
    );
    if (ok) setEmail("");
  }

  return (
    <section className="bg-card rounded-2xl border p-6">
      <h2 className="text-base font-semibold">Email suppression list</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        Addresses this workspace never emails — broadcasts, workflows, inbox replies, quotes,
        invoices and booking emails all refuse them. Remove an address to email it again.
      </p>
      <form onSubmit={(e) => void add(e)} className="mt-4 flex flex-wrap items-end gap-2">
        <div className="min-w-56 flex-1">
          <Label htmlFor="suppress-email">Email address</Label>
          <Input
            id="suppress-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="suppress-reason">Reason</Label>
          <select
            id="suppress-reason"
            className="border-input bg-background h-9 rounded-md border px-2 text-sm"
            value={reason}
            onChange={(e) => setReason(e.target.value as EmailSuppressionReason)}
          >
            {REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" disabled={busy}>
          Suppress
        </Button>
      </form>
      {items === null ? (
        !error && <p className="mt-4 text-sm">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-muted-foreground mt-4 text-sm">No suppressed addresses.</p>
      ) : (
        <ul className="mt-4 divide-y text-sm">
          {items.map((item) => (
            <li key={item.email} className="flex items-center justify-between gap-2 py-2">
              <span className="min-w-0 truncate">
                {item.email}
                <span className="text-muted-foreground ml-2 text-xs">
                  {REASONS.find((r) => r.value === item.reason)?.label ?? item.reason}
                  {item.createdAt ? ` · ${new Date(item.createdAt).toLocaleDateString()}` : ""}
                </span>
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    fetch(`${url}?email=${encodeURIComponent(item.email)}`, { method: "DELETE" })
                  )
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-destructive mt-3 text-sm">
          {error}
        </p>
      )}
    </section>
  );
}
