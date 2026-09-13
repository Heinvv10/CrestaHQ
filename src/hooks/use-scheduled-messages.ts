"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { isStaleSending, type ScheduledMessageView } from "@/types/scheduled-messages";
import { viewTimes } from "@/lib/conversations/scheduled-item";

/**
 * A contact's scheduled messages (SP2 T5), read through the server API — the
 * collection is server-only in Firestore rules.
 *
 * Refetches when:
 *   - `pulse` changes (the thread passes its row count: a scheduled message
 *     that fires writes a message row, so the thread moving is the cue);
 *   - the composer announces a booking (announceScheduledChange);
 *   - every POLL_MS while anything is still pending or sending, so a message
 *     that FAILS at fire time — which writes no message row — still shows.
 */
const EVENT = "ls:scheduled-messages-changed";
const POLL_MS = 15_000;

export function announceScheduledChange(contactId: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: contactId }));
}

export function scheduledMessagesBase(subAccountId: string): string {
  return `/api/sub-accounts/${encodeURIComponent(subAccountId)}/scheduled-messages`;
}

export function scheduledMessagesUrl(subAccountId: string, contactId: string, id?: string) {
  const base = scheduledMessagesBase(subAccountId);
  const q = `contactId=${encodeURIComponent(contactId)}`;
  return id ? `${base}/${encodeURIComponent(id)}?${q}` : `${base}?${q}`;
}

/**
 * True while something can still change on its own: a pending message, or one
 * sending right now. A stale "sending" one (its worker died mid-send) will
 * never change, so it does not keep the thread polling.
 */
export function needsPolling(
  messages: Pick<ScheduledMessageView, "status" | "sendAt" | "claimedAt">[],
  nowMs: number
): boolean {
  return messages.some(
    (m) =>
      m.status === "pending" ||
      (m.status === "sending" && !isStaleSending(viewTimes(m), nowMs))
  );
}

export function useScheduledMessages(
  subAccountId: string | null | undefined,
  contactId: string | null | undefined,
  pulse: number
) {
  const [messages, setMessages] = useState<ScheduledMessageView[]>([]);
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!subAccountId || !contactId) {
      setMessages([]);
      return;
    }
    let live = true;
    fetch(scheduledMessagesUrl(subAccountId, contactId))
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as {
          messages?: ScheduledMessageView[];
        };
        if (!live) return;
        if (!res.ok || !Array.isArray(data.messages)) {
          setError(true);
          return;
        }
        setMessages(data.messages);
        setError(false);
      })
      .catch(() => {
        if (live) setError(true);
      });
    return () => {
      live = false;
    };
  }, [subAccountId, contactId, pulse, tick]);

  useEffect(() => {
    if (!contactId) return;
    const onChange = (e: Event) => {
      if ((e as CustomEvent<string>).detail === contactId) refresh();
    };
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, [contactId, refresh]);

  const waiting = needsPolling(messages, Date.now());
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, refresh]);

  /** Cancel a pending message, or dismiss a failed / unconfirmed one. */
  const remove = useCallback(
    async (id: string) => {
      if (!subAccountId || !contactId) return;
      try {
        const res = await fetch(scheduledMessagesUrl(subAccountId, contactId, id), {
          method: "DELETE",
        });
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          action?: "cancelled" | "dismissed";
        };
        if (!res.ok) throw new Error(data.error ?? `Couldn't update (HTTP ${res.status}).`);
        toast.success(
          data.action === "dismissed" ? "Dismissed." : "Scheduled message cancelled."
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't update.");
      } finally {
        refresh();
      }
    },
    [subAccountId, contactId, refresh]
  );

  return { messages, error, remove };
}
