"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { ScheduledMessageView } from "@/types/scheduled-messages";

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

  const waiting = messages.some((m) => m.status === "pending" || m.status === "sending");
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, refresh]);

  const cancel = useCallback(
    async (id: string) => {
      if (!subAccountId || !contactId) return;
      try {
        const res = await fetch(scheduledMessagesUrl(subAccountId, contactId, id), {
          method: "DELETE",
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(data.error ?? `Couldn't cancel (HTTP ${res.status}).`);
        toast.success("Scheduled message cancelled.");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't cancel.");
      } finally {
        refresh();
      }
    },
    [subAccountId, contactId, refresh]
  );

  return { messages, error, cancel };
}
