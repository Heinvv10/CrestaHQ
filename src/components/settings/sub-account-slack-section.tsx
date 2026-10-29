"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Hash, Loader2 } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WEBHOOK_EVENT_CATEGORIES } from "@/lib/webhooks/event-categories";
import type { SlackConfigResponse } from "@/types/slack";
import type { WebhookEventType } from "@/types/webhooks";

/**
 * Slack notifications card. Paste an Incoming Webhook URL (proven with a
 * test post before it's stored), tick the events to post, send a test. The
 * URL is never shown again; "Reconnect" means pasting a new one.
 */

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const EVENT_LABELS: Partial<Record<WebhookEventType, string>> = {
  "contact.created": "New lead",
  "contact.updated": "Contact updated",
  "contact.deleted": "Contact deleted",
  "deal.created": "Deal created",
  "deal.updated": "Deal updated",
  "deal.deleted": "Deal deleted",
  "deal.stage.changed": "Deal moved stage",
  "deal.won": "Deal won",
  "deal.lost": "Deal lost",
  "task.created": "Task created",
  "task.completed": "Task completed",
  "event.created": "Calendar event created",
  "form.submitted": "Form submitted",
  "quote.sent": "Quote sent",
  "quote.viewed": "Quote opened",
  "quote.accepted": "Quote accepted / signed",
  "quote.declined": "Quote declined",
  "quote.paid": "Quote or invoice paid",
  "booking.created": "New booking",
  "booking.cancelled": "Booking cancelled",
  "voice.call.completed": "AI voice call ended",
  "voice.call.captured": "AI voice call captured a lead",
  "webchat.lead.captured": "Web chat captured a lead",
  "member.invited": "Team member invited",
  "member.added": "Team member added",
  "automation.completed": "Workflow completed",
  "message.received": "Inbound message",
  "call.missed": "Missed call",
  "community.member.joined": "Community member joined",
  "community.member.approved": "Community member approved",
  "community.purchase.paid": "Community purchase paid",
  "community.lesson.completed": "Lesson completed",
  "community.course.completed": "Course completed",
  "billing.plan.assigned": "Billing plan assigned",
  "billing.activated": "Billing activated",
  "billing.past_due": "Billing past due",
  "billing.canceled": "Billing cancelled",
  "billing.charge.paid": "One-time charge paid",
  "order.paid": "Order paid",
  "order.refunded": "Order refunded",
};

export function SubAccountSlackSection() {
  const { subAccountId, isAdmin } = useSubAccount();
  const [config, setConfig] = useState<SlackConfigResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [channelLabel, setChannelLabel] = useState("");
  const [events, setEvents] = useState<WebhookEventType[]>([]);
  const [eventsDirty, setEventsDirty] = useState(false);
  const [busy, setBusy] = useState<null | "connect" | "save" | "test" | "disconnect">(null);
  const [reconnecting, setReconnecting] = useState(false);

  const hydrate = useCallback(async () => {
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/slack`);
      const data = (await res.json()) as { config?: SlackConfigResponse };
      if (data.config) {
        setConfig(data.config);
        setEvents(data.config.events);
        setEventsDirty(false);
      }
    } catch {
      toast.error("Couldn't load the Slack settings.");
    } finally {
      setLoaded(true);
    }
  }, [subAccountId]);

  useEffect(() => {
    if (!isAdmin) return;
    void hydrate();
  }, [isAdmin, hydrate]);

  if (!isAdmin) return null;

  const connected = config?.connected === true;
  const showForm = !connected || reconnecting;

  async function handleConnect(e: FormEvent) {
    e.preventDefault();
    setBusy("connect");
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/slack`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          webhookUrl: webhookUrl.trim(),
          // Omitted when blank so a reconnect keeps the saved label.
          ...(channelLabel.trim() ? { channelLabel: channelLabel.trim() } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        config?: SlackConfigResponse;
      };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to connect.");
      if (data.config) {
        setConfig(data.config);
        setEvents(data.config.events);
        setEventsDirty(false);
      }
      setWebhookUrl("");
      setChannelLabel("");
      setReconnecting(false);
      toast.success("Slack connected. A test message was posted to the channel.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to connect.");
    } finally {
      setBusy(null);
    }
  }

  async function handleSaveEvents() {
    setBusy("save");
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/slack`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        config?: SlackConfigResponse;
      };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to save.");
      if (data.config) setConfig(data.config);
      setEventsDirty(false);
      toast.success("Slack events saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setBusy(null);
    }
  }

  async function handleTest() {
    setBusy("test");
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/slack/test`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        config?: SlackConfigResponse;
      };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Test failed.");
      if (data.config) setConfig(data.config);
      toast.success("Test message posted.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test failed.");
      void hydrate();
    } finally {
      setBusy(null);
    }
  }

  async function handleDisconnect() {
    if (!confirm("Disconnect Slack? Notifications stop within a minute; the channel and its history are untouched.")) {
      return;
    }
    setBusy("disconnect");
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/slack`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to disconnect.");
      await hydrate();
      setReconnecting(false);
      toast.success("Slack disconnected.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disconnect.");
    } finally {
      setBusy(null);
    }
  }

  const toggleEvent = (ev: WebhookEventType) => {
    setEvents((cur) => (cur.includes(ev) ? cur.filter((x) => x !== ev) : [...cur, ev]));
    setEventsDirty(true);
  };

  return (
    <section className="rounded-2xl border bg-card p-6">
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
          <Hash className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">Slack notifications</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Post new leads, bookings, replies, quotes and more to a Slack
            channel. In Slack, open{" "}
            <a
              href="https://api.slack.com/messaging/webhooks"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Incoming Webhooks
            </a>
            , add one for the channel you want, and paste the URL here.
          </p>
        </div>
      </header>

      {!loaded ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </p>
      ) : (
        <div className="space-y-4">
          {connected && !reconnecting && (
            <div
              className={
                "rounded-lg border p-4 " +
                (config?.needsReconnect
                  ? "border-amber-500/30 bg-amber-500/5"
                  : "border-emerald-500/30 bg-emerald-500/5")
              }
            >
              <p
                className={
                  "flex items-center gap-2 text-sm " +
                  (config?.needsReconnect
                    ? "text-amber-700 dark:text-amber-400"
                    : "text-emerald-700 dark:text-emerald-400")
                }
              >
                {config?.needsReconnect ? (
                  <AlertTriangle className="h-4 w-4" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                {config?.needsReconnect
                  ? "Needs attention: Slack no longer accepts this webhook URL."
                  : `Connected${config?.channelLabel ? ` to ${config.channelLabel}` : ""}`}
                {config?.urlTail && (
                  <span className="font-mono text-xs text-muted-foreground">
                    …{config.urlTail}
                  </span>
                )}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Last post {relativeTime(config?.lastSentAt ?? null)}
                {config?.lastError ? ` · last error: ${config.lastError}` : ""}
              </p>
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Button type="button" variant="outline" size="sm" onClick={handleTest} disabled={busy !== null}>
                  {busy === "test" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                  Send test
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setReconnecting(true)} disabled={busy !== null}>
                  Reconnect
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={handleDisconnect} disabled={busy !== null}>
                  {busy === "disconnect" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                  Disconnect
                </Button>
              </div>
            </div>
          )}

          {showForm && (
            <form onSubmit={handleConnect} className="space-y-3">
              <div>
                <Label htmlFor="slack-webhook-url" className="text-xs uppercase tracking-wider text-muted-foreground">
                  Incoming Webhook URL
                </Label>
                <Input
                  id="slack-webhook-url"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="https://hooks.slack.com/services/…"
                  autoComplete="off"
                  spellCheck={false}
                  className="mt-1 font-mono text-xs"
                  required
                />
              </div>
              <div>
                <Label htmlFor="slack-channel" className="text-xs uppercase tracking-wider text-muted-foreground">
                  Channel name (optional, for your reference)
                </Label>
                <Input
                  id="slack-channel"
                  value={channelLabel}
                  onChange={(e) => setChannelLabel(e.target.value)}
                  placeholder="#sales"
                  maxLength={60}
                  className="mt-1 max-w-xs"
                />
              </div>
              <div className="flex items-center gap-2">
                <Button type="submit" size="sm" disabled={busy !== null || !webhookUrl.trim()}>
                  {busy === "connect" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                  {connected ? "Save new URL" : "Connect Slack"}
                </Button>
                {reconnecting && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setReconnecting(false)} disabled={busy !== null}>
                    Cancel
                  </Button>
                )}
                <span className="text-[11px] text-muted-foreground">
                  A test message is posted before the URL is saved.
                </span>
              </div>
            </form>
          )}

          {connected && (
            <div className="space-y-3 border-t pt-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Post to Slack when
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {WEBHOOK_EVENT_CATEGORIES.map((group) => (
                  <div key={group.label}>
                    <p className="mb-1 text-xs font-medium">{group.label}</p>
                    <div className="space-y-1">
                      {group.events.map((ev) => (
                        <label key={ev} className="flex cursor-pointer items-center gap-2 text-sm">
                          <Checkbox
                            checked={events.includes(ev)}
                            onCheckedChange={() => toggleEvent(ev)}
                            disabled={busy !== null}
                          />
                          <span>{EVENT_LABELS[ev] ?? ev}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex justify-end">
                <Button type="button" size="sm" onClick={handleSaveEvents} disabled={busy !== null || !eventsDirty}>
                  {busy === "save" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                  Save events
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
