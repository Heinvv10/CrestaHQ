"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Smartphone } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import {
  ConnectPanel,
  ConnectedPanel,
  NoCodePanel,
  OrphanPanel,
  QrPanel,
  type BridgeBusy,
} from "@/components/settings/sub-account-whatsapp-bridge-panels";
import {
  bridgePollMode,
  bridgeStatusFrom,
  type BridgeStatus,
  type PairingAnswer,
} from "@/lib/comms/whatsapp/bridge-card-status";

/**
 * Sub-account WhatsApp bridge settings — the `bridge` arm of the provider seam,
 * self-serve: an admin pairs their own number without an operator on the box.
 *
 * Self-gating exactly like the Cloud card, on the SAME agency flag. The agency
 * decides whether this workspace may use WhatsApp at all; which rail it uses
 * inside that is the workspace admin's call, so there is no second gate to
 * forget to wire.
 *
 * THE QR IS AN IMAGE, NOT A STRING. The pairing payload is a write-grade
 * credential and never reaches this component in any form — `../pairing`
 * answers only whether a round is in flight and when it lapses, and `../qr`
 * answers with pixels. Nothing here has a code to mishandle, log, or stash.
 *
 * THE RISK CHECKBOX IS NOT THE GATE. `../provision` refuses without a recorded
 * acknowledgement, so deleting the checkbox breaks connecting rather than
 * opening it.
 */

const POLL_MS = 4000;
/** About a minute of retries. A bridge the manager has just started or bounced
 *  answers within a few seconds; anything still failing after this is not
 *  waiting on a restart, and "Try again" is right there. */
const RECOVERY_POLLS = 15;

export function SubAccountWhatsappBridgeSection() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();
  const [status, setStatus] = useState<BridgeStatus>({ kind: "loading" });
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState<BridgeBusy>(null);
  const [qrNonce, setQrNonce] = useState(0);

  const base = `/api/sub-accounts/${subAccountId}/whatsapp-bridge`;

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${base}/pairing`, { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as PairingAnswer;
      setStatus(bridgeStatusFrom(res.status, data));
    } catch {
      setStatus({
        kind: "error",
        message: "Couldn't read the connection status.",
      });
    }
  }, [base]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** How many bounded retries are left. A ref, not state: spending one must
   *  not itself re-render and restart the interval it is bounding. */
  const recoveryLeft = useRef(RECOVERY_POLLS);

  // Polling. `pairing` runs for as long as the screen does — the scan happens
  // on the customer's phone with nothing to tell this page about it — while
  // the two recovery states get a capped run at resolving themselves. See
  // `bridgePollMode` for why each state is where it is; the cap is what stops
  // a genuinely broken deployment being polled by every open tab forever.
  useEffect(() => {
    const mode = bridgePollMode(status.kind);
    // A settled answer refills the budget, so a later failure gets a fresh
    // window instead of inheriting an exhausted one. Moving between the two
    // recovery states does NOT refill it: they can alternate.
    if (mode === "none") {
      recoveryLeft.current = RECOVERY_POLLS;
      return;
    }
    const timer = setInterval(() => {
      if (mode === "bounded") {
        if (recoveryLeft.current <= 0) {
          clearInterval(timer);
          return;
        }
        recoveryLeft.current -= 1;
      }
      void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [status.kind, refresh]);

  /** The manual "Try again". An explicit ask refills the budget — the admin
   *  has told us the wait is worth restarting. */
  const retry = useCallback(() => {
    recoveryLeft.current = RECOVERY_POLLS;
    void refresh();
  }, [refresh]);

  /** One mutating call. A refusal is raised, never swallowed. */
  async function post(path: string, method = "POST") {
    const res = await fetch(`${base}${path}`, { method });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
    };
    if (!res.ok || !data.ok) {
      throw new Error(data.error ?? "That didn't work. Try again.");
    }
  }

  async function handleConnect() {
    setBusy("connect");
    try {
      // Recorded FIRST because the provisioning route refuses without it: the
      // order here is the one the server enforces, not a UI convention.
      await post("/risk-ack");
      await post("/provision");
      setQrNonce((n) => n + 1);
      await refresh();
      toast.success("Bridge created — scan the code with WhatsApp to pair.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't connect.");
    } finally {
      setBusy(null);
    }
  }

  async function handleNewCode() {
    setBusy("code");
    try {
      await post("/restart");
      setQrNonce((n) => n + 1);
      await refresh();
      toast.success("Restarting — a new code appears in a few seconds.");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't get a new code.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function handleDisconnect() {
    if (
      !confirm(
        "Disconnect this WhatsApp number? The WhatsApp session is erased, so this workspace stops sending and receiving on it immediately, and reconnecting means scanning a new QR code with the phone.",
      )
    ) {
      return;
    }
    setBusy("disconnect");
    try {
      await post("", "DELETE");
      setAccepted(false);
      await refresh();
      toast.success("Disconnected.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't disconnect.");
    } finally {
      setBusy(null);
    }
  }

  if (!isAdmin) return null;
  if (subAccount?.whatsappEnabledByAgency !== true) return null;

  // The nonce changes on every action, and the expiry changes whenever the
  // bridge issues a fresh code, so the browser refetches the image exactly
  // when there is a new one to fetch and not once per poll.
  const qrSrc =
    status.kind === "pairing"
      ? `${base}/qr?v=${encodeURIComponent(status.expiresAt ?? "")}-${qrNonce}`
      : "";

  return (
    <section className="rounded-2xl border bg-card p-6">
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          <Smartphone className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">
            WhatsApp — your own number
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Link the WhatsApp number you already use by scanning a code with the
            phone it lives on. No Meta business account and no message
            templates — read the risks before you start.
          </p>
        </div>
      </header>

      {status.kind === "loading" && (
        <p className="text-sm text-muted-foreground">Checking…</p>
      )}

      {status.kind === "unavailable" && (
        <p className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
          Connecting your own number isn&apos;t available on this deployment.
          Use the Meta Cloud API card instead.
        </p>
      )}

      {status.kind === "error" && (
        <div className="space-y-3">
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-700 dark:text-amber-400">
            {status.message}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={retry}
          >
            Try again
          </Button>
        </div>
      )}

      {status.kind === "absent" && (
        <ConnectPanel
          accepted={accepted}
          onAcceptedChange={setAccepted}
          onConnect={() => void handleConnect()}
          busy={busy}
        />
      )}

      {status.kind === "orphaned" && (
        <OrphanPanel
          onDisconnect={() => void handleDisconnect()}
          busy={busy}
        />
      )}

      {status.kind === "nocode" && (
        <NoCodePanel
          onNewCode={() => void handleNewCode()}
          onRemove={() => void handleDisconnect()}
          busy={busy}
        />
      )}

      {status.kind === "pairing" && (
        <QrPanel
          qrSrc={qrSrc}
          expiresAt={status.expiresAt}
          onNewCode={() => void handleNewCode()}
          onRemove={() => void handleDisconnect()}
          busy={busy}
        />
      )}

      {status.kind === "connected" && (
        <ConnectedPanel
          phoneNumber={
            subAccount?.whatsappBridgeMeta?.displayPhoneNumber ?? null
          }
          onDisconnect={() => void handleDisconnect()}
          busy={busy}
        />
      )}
    </section>
  );
}
