"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Smartphone } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import {
  ConnectPanel,
  ConnectedPanel,
  QrPanel,
  type BridgeBusy,
} from "@/components/settings/sub-account-whatsapp-bridge-panels";

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

/** What the manager says about this workspace right now. */
type Status =
  | { kind: "loading" }
  /** No manager on this deployment (a buyer copy, a dev box). Not an outage. */
  | { kind: "unavailable" }
  /** No bridge provisioned for this workspace yet. */
  | { kind: "absent" }
  | { kind: "pairing"; expiresAt?: string }
  | { kind: "connected" }
  | { kind: "error"; message: string };

const POLL_MS = 4000;

export function SubAccountWhatsappBridgeSection() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState<BridgeBusy>(null);
  const [qrNonce, setQrNonce] = useState(0);

  const base = `/api/sub-accounts/${subAccountId}/whatsapp-bridge`;

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${base}/pairing`, { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as {
        connected?: boolean;
        expiresAt?: string;
        error?: string;
      };
      // 503 is "this deployment has no manager" and 404 is "the manager has no
      // tenant for this workspace" — two ordinary answers that must not read
      // as breakage. Everything else genuinely is a fault worth showing.
      if (res.status === 503) setStatus({ kind: "unavailable" });
      else if (res.status === 404) setStatus({ kind: "absent" });
      else if (!res.ok)
        setStatus({
          kind: "error",
          message: data.error ?? "Couldn't read the connection status.",
        });
      else if (data.connected) setStatus({ kind: "connected" });
      else setStatus({ kind: "pairing", expiresAt: data.expiresAt });
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

  // Polling exists only for the pairing screen: the scan completes on the
  // customer's phone, with nothing to tell this page about it. It stops the
  // moment the state leaves `pairing`, so a connected workspace — and a
  // deployment with no manager — sits quiet.
  useEffect(() => {
    if (status.kind !== "pairing") return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [status.kind, refresh]);

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
            onClick={() => void refresh()}
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
