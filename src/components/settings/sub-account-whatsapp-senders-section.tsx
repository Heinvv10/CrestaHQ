"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { CheckCircle2, Loader2, Phone, Star, Trash2 } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { WhatsAppProviderId } from "@/lib/comms/whatsapp/provider";
import type { WhatsAppSender } from "@/types/whatsapp-senders";

/**
 * The sub-account's WhatsApp sender registry — the numbers a workflow step can
 * pick between.
 *
 * A workspace that has never added one still sees a row here: the resolver
 * synthesizes a sender from the rail the workspace already runs on, and the
 * card says so, because that row is what an unset workflow step sends from.
 *
 * Display metadata only. Credentials stay on the rail cards above; a sender
 * added here sends on that rail's existing connection.
 */

const RAIL_OPTIONS: { value: WhatsAppProviderId; label: string }[] = [
  { value: "twilio", label: "Twilio" },
  { value: "cloud", label: "WhatsApp Cloud" },
  { value: "bridge", label: "Linked device" },
];

export function SubAccountWhatsappSendersSection() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();
  const [senders, setSenders] = useState<WhatsAppSender[]>([]);
  const [synthesized, setSynthesized] = useState(true);
  const [label, setLabel] = useState("");
  const [provider, setProvider] = useState<WhatsAppProviderId>("twilio");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const enabled =
    isAdmin === true && subAccount?.whatsappEnabledByAgency === true;

  const load = useCallback(async () => {
    if (!subAccountId) return;
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/whatsapp-senders`,
      );
      const data = (await res.json().catch(() => ({}))) as {
        senders?: WhatsAppSender[];
        synthesized?: boolean;
      };
      setSenders(data.senders ?? []);
      setSynthesized(data.synthesized !== false);
    } catch {
      /* the card just shows an empty list — the rail cards above still work */
    }
  }, [subAccountId]);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  if (!enabled) return null;

  async function send(init: RequestInit, failure: string, query = "") {
    const res = await fetch(
      `/api/sub-accounts/${subAccountId}/whatsapp-senders${query}`,
      init,
    );
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
    };
    if (!res.ok || !data.ok) throw new Error(data.error ?? failure);
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await send(
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label, provider, phoneNumber }),
        },
        "Couldn't add the sender.",
      );
      setLabel("");
      setPhoneNumber("");
      toast.success("Sender added.");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add the sender.");
    } finally {
      setSaving(false);
    }
  }

  async function makeDefault(id: string) {
    setBusyId(id);
    try {
      await send(
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, isDefault: true }),
        },
        "Couldn't set the default.",
      );
      toast.success("Default sender updated.");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't set the default.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(sender: WhatsAppSender) {
    if (
      !confirm(
        `Remove ${sender.label}? Any workflow step set to send from this number will stop sending until you pick another sender.`,
      )
    ) {
      return;
    }
    setBusyId(sender.id);
    try {
      await send(
        { method: "DELETE" },
        "Couldn't remove the sender.",
        `?senderId=${encodeURIComponent(sender.id)}`,
      );
      toast.success("Sender removed.");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove the sender.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-6">
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          <Phone className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">WhatsApp senders</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            The numbers this workspace can send WhatsApp from. A workflow step
            sends from the default unless it names one of these.
          </p>
        </div>
      </header>

      <ul className="space-y-2">
        {senders.map((s) => (
          <li
            key={s.id}
            className="flex flex-wrap items-center gap-3 rounded-lg border p-3"
          >
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-sm font-medium">
                {s.label}
                {s.isDefault && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                    <CheckCircle2 className="h-3 w-3" />
                    Default
                  </span>
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {s.phoneNumber || "No number"} · {s.provider}
              </p>
            </div>
            {!synthesized && (
              <div className="flex items-center gap-2">
                {!s.isDefault && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busyId === s.id}
                    onClick={() => makeDefault(s.id)}
                  >
                    <Star className="mr-1 h-3.5 w-3.5" />
                    Make default
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busyId === s.id}
                  onClick={() => remove(s)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {synthesized && (
        <p className="mt-2 text-xs text-muted-foreground">
          This is the number the workspace already sends from, taken from the
          rail it runs on. Add a sender below to start choosing between numbers.
        </p>
      )}

      <form onSubmit={handleAdd} className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="wa-sender-label">Label</Label>
          <Input
            id="wa-sender-label"
            value={label}
            placeholder="Sales"
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="wa-sender-number">Number</Label>
          <Input
            id="wa-sender-number"
            value={phoneNumber}
            placeholder="+27784356159"
            onChange={(e) => setPhoneNumber(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="wa-sender-rail">Rail</Label>
          <select
            id="wa-sender-rail"
            value={provider}
            onChange={(e) => setProvider(e.target.value as WhatsAppProviderId)}
            className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
          >
            {RAIL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-3 flex justify-end">
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                Adding…
              </>
            ) : (
              "Add sender"
            )}
          </Button>
        </div>
      </form>
    </section>
  );
}
