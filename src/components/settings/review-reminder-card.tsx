"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  REMINDER_MAX_EVERY_DAYS,
  REMINDER_MAX_RETRIES,
  normalizeReviewChannel,
  parseReminderSettings,
} from "@/lib/reviews/constants";

/**
 * Review-request reminders (SP5 d2) — GHL's "Until clicked, repeat this every
 * N days / Maximum retries". Off unless an admin turns it on; saved on its own
 * with PATCH …/google-review, so the review-request form above never touches it.
 */

type Result = { state: "saved" | "error"; message: string } | null;

const DAY_OPTIONS = Array.from({ length: REMINDER_MAX_EVERY_DAYS }, (_, i) => i + 1);
const RETRY_OPTIONS = Array.from({ length: REMINDER_MAX_RETRIES }, (_, i) => i + 1);
const selectClass = "h-9 w-full rounded-lg border border-input bg-background px-2 text-sm disabled:opacity-50";

export function ReviewReminderCard() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();
  const cfg = subAccount?.googleReviewConfig ?? null;
  const stored = parseReminderSettings(cfg?.reminder);
  const [every, setEvery] = useState<string>("off");
  const [retries, setRetries] = useState<number>(2);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<Result>(null);

  useEffect(() => {
    setEvery(stored?.everyDays ? String(stored.everyDays) : "off");
    setRetries(stored?.maxRetries ?? 2);
  }, [stored?.everyDays, stored?.maxRetries]);

  if (!isAdmin) return null;
  const template = normalizeReviewChannel(cfg?.channel) === "whatsapp_template";

  async function save() {
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/google-review`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reminder: { everyDays: every === "off" ? null : Number(every), maxRetries: retries } }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setResult(res.ok ? { state: "saved", message: "Reminder setting saved." } : { state: "error", message: data.error ?? "Couldn't save the reminder setting." });
    } catch {
      setResult({ state: "error", message: "Couldn't save the reminder setting." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-6 space-y-3 border-t pt-5" data-testid="rep-reminder-card">
      <div>
        <h3 className="text-sm font-semibold">Reminders</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Off by default. When on, a customer who hasn&apos;t clicked the review link gets the same request again.
          Reminders stop when the customer clicks the link, opts out, or the retries run out.
        </p>
        {template && (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="rep-reminder-template-note">
            Your review requests use an approved WhatsApp template, whose link is fixed — it can&apos;t be tracked, so
            reminders stop only when the customer opts out or the retries run out.
          </p>
        )}
      </div>
      {!cfg?.reviewUrl ? (
        <p className="text-sm text-muted-foreground" data-testid="rep-reminder-no-link">Save your review link first.</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="rep-reminder-every">Until clicked, repeat every</Label>
              <select id="rep-reminder-every" value={every} onChange={(e) => setEvery(e.target.value)} className={selectClass} data-testid="rep-reminder-every">
                <option value="off">Don&apos;t repeat</option>
                {DAY_OPTIONS.map((d) => <option key={d} value={String(d)}>{d === 1 ? "1 day" : `${d} days`}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rep-reminder-retries">Maximum reminders</Label>
              <select
                id="rep-reminder-retries"
                value={retries}
                onChange={(e) => setRetries(Number(e.target.value))}
                disabled={every === "off"}
                className={selectClass}
                data-testid="rep-reminder-retries"
              >
                {RETRY_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" size="sm" onClick={save} disabled={saving} data-testid="rep-reminder-save">
              {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} Save reminders
            </Button>
            {result && (
              <span
                role={result.state === "saved" ? "status" : "alert"}
                className={result.state === "saved" ? "text-xs text-emerald-700 dark:text-emerald-400" : "text-xs text-destructive"}
                data-testid="rep-reminder-result"
                data-state={result.state}
              >
                {result.message}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
