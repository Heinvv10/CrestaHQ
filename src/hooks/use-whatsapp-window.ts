"use client";

import { useEffect, useState } from "react";
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import { useSubAccount } from "@/context/sub-account-context";
import { resolveWhatsappSender } from "@/lib/comms/whatsapp/resolve-sender";
import { DEFAULT_WA_WINDOW_HOURS } from "@/lib/comms/whatsapp/send-mode";
import {
  latestInboundAt,
  waWindowState,
  type WaWindowState,
} from "@/lib/comms/whatsapp/window-state";
import type { WhatsAppProviderId } from "@/lib/comms/whatsapp/provider";

export type WhatsappWindowView = {
  state: WaWindowState;
  provider: WhatsAppProviderId;
};

/**
 * Live WhatsApp window state for the composer (SP2 T8). Null while inactive
 * (another channel selected), while loading, when the sub-account has no
 * resolvable sender, or when a read fails — in every one of those the
 * composer shows no window UI and the send route decides, as before.
 *
 * Reads exactly what the send route reads: the rail from the sender registry
 * (`resolveWhatsappSender`), the last inbound row among the newest 50
 * `whatsappMessages`, and `aiAgent/whatsapp`.whatsapp.sessionWindowHours.
 */
export function useWhatsappWindow(
  contactId: string,
  active: boolean,
): WhatsappWindowView | null {
  const { subAccount, subAccountId } = useSubAccount();
  const resolved = active ? resolveWhatsappSender(subAccount) : null;
  const provider = resolved?.ok ? resolved.provider : null;
  const enforces = !!(resolved?.ok && resolved.capabilities.enforcesWindow);

  // Each read is tagged with the key it was made for, so a stale value from a
  // previous contact or sub-account is never shown for the current one.
  const [inbound, setInbound] = useState<{ key: string; at: Date | null } | null>(null);
  const [hours, setHours] = useState<{ key: string; value: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enforces || !contactId) return;
    const q = query(
      collection(getFirebaseDb(), `contacts/${contactId}/whatsappMessages`),
      orderBy("createdAt", "desc"),
      limit(50),
    );
    return onSnapshot(
      q,
      (snap) => {
        setInbound({
          key: contactId,
          at: latestInboundAt(snap.docs.map((d) => d.data())),
        });
        setNow(Date.now());
      },
      (err) => {
        console.warn("[whatsapp-window] message read failed", err);
        setInbound(null);
      },
    );
  }, [enforces, contactId]);

  useEffect(() => {
    if (!enforces || !subAccountId) return;
    return onSnapshot(
      doc(getFirebaseDb(), `subAccounts/${subAccountId}/aiAgent/whatsapp`),
      (snap) => {
        const v = (snap.data() as { whatsapp?: { sessionWindowHours?: number } | null } | undefined)
          ?.whatsapp?.sessionWindowHours;
        setHours({ key: subAccountId, value: v ?? DEFAULT_WA_WINDOW_HOURS });
        setNow(Date.now());
      },
      (err) => {
        console.warn("[whatsapp-window] channel config read failed", err);
        setHours(null);
      },
    );
  }, [enforces, subAccountId]);

  const state =
    !provider
      ? null
      : !enforces
        ? waWindowState({ enforcesWindow: false, lastInboundAt: null, now: new Date(now) })
        : inbound?.key === contactId && hours?.key === subAccountId
          ? waWindowState({
              enforcesWindow: true,
              lastInboundAt: inbound.at,
              now: new Date(now),
              windowHours: hours.value,
            })
          : null;

  // Live countdown at minute granularity: re-render as each displayed minute
  // rolls over, which also lands on the closing moment itself, so the
  // composer flips to "closed" when the window does.
  const msLeft = state?.kind === "open" ? state.msLeft : null;
  useEffect(() => {
    if (msLeft === null) return;
    const t = setTimeout(() => setNow(Date.now()), (msLeft % 60_000) + 50);
    return () => clearTimeout(t);
  }, [msLeft]);

  return state && provider ? { state, provider } : null;
}
