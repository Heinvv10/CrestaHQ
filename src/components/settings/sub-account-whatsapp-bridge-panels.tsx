"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WA_BRIDGE_RISK_TEXT } from "@/types/whatsapp-bridge";

/**
 * The substantive states of the WhatsApp bridge card, split out of
 * `sub-account-whatsapp-bridge-section` purely to keep both files inside the
 * 300-line rule. All fetching, polling and app state stays in the section.
 *
 * Nothing here ever receives a pairing code. `QrPanel` is handed a URL to an
 * image route, which is the only form the payload takes outside the server.
 */

/** Which action is in flight, so every control disables together. */
export type BridgeBusy = null | "connect" | "code" | "disconnect";

function Spinner({ label }: { label: string }) {
  return (
    <>
      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
      {label}
    </>
  );
}

/**
 * No bridge yet: the risk warning, the acknowledgement, then Connect. The
 * checkbox is a collection device, not a gate — the provisioning route refuses
 * without a RECORDED acknowledgement, so removing this control breaks
 * connecting rather than bypassing the warning.
 */
export function ConnectPanel({
  accepted,
  onAcceptedChange,
  onConnect,
  busy,
}: {
  accepted: boolean;
  onAcceptedChange: (v: boolean) => void;
  onConnect: () => void;
  busy: BridgeBusy;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
        <p className="font-medium text-amber-800 dark:text-amber-300">
          Before you connect — the risks
        </p>
        {WA_BRIDGE_RISK_TEXT.split("\n\n").map((para) => (
          <p key={para} className="mt-2 text-amber-800/90 dark:text-amber-200/90">
            {para}
          </p>
        ))}
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={accepted}
          onChange={(e) => onAcceptedChange(e.target.checked)}
        />
        <span>
          I&apos;ve read the risks above and accept them for the number
          I&apos;m about to connect.
        </span>
      </label>
      <div className="flex justify-end">
        <Button
          type="button"
          onClick={onConnect}
          disabled={!accepted || busy !== null}
        >
          {busy === "connect" ? (
            <Spinner label="Creating…" />
          ) : (
            "Connect my number"
          )}
        </Button>
      </div>
    </div>
  );
}

/**
 * Waiting for a scan. "Get a new code" is given equal weight to the QR on
 * purpose: codes lapse in about a minute and a bridge issues only a handful
 * before it stops until it is restarted, so the common failure is a dead image
 * with no obvious way forward.
 */
export function QrPanel({
  qrSrc,
  expiresAt,
  onNewCode,
  onRemove,
  busy,
}: {
  qrSrc: string;
  expiresAt?: string;
  onNewCode: () => void;
  onRemove: () => void;
  busy: BridgeBusy;
}) {
  // Local render state only. `../qr` refuses with a status, not an image, and
  // an <img> pointed at a refusal draws the browser's broken-image glyph and
  // nothing else. Reset on every new source, so a fresh code gets its own try.
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [qrSrc]);

  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-muted/30 p-4 text-sm">
        <p className="font-medium">Scan this with WhatsApp</p>
        <p className="mt-1 text-xs text-muted-foreground">
          On the phone: WhatsApp → Settings → Linked devices → Link a device.
          Codes lapse after about a minute, and a bridge only issues a few
          before it needs restarting — if the code below is stale or blank, get
          a new one.
        </p>
        {broken ? (
          <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">
            That code couldn&apos;t be loaded — it has probably lapsed. Get a
            new one.
          </p>
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element -- a same-origin,
             no-store PNG that must never be cached or run through the image
             optimiser: it encodes a live credential. */
          <img
            src={qrSrc}
            alt="WhatsApp pairing QR code"
            width={280}
            height={280}
            className="mt-3 rounded bg-white p-2"
            onError={() => setBroken(true)}
          />
        )}
        {expiresAt ? (
          <p className="mt-2 text-xs text-muted-foreground">
            This code lapses at {new Date(expiresAt).toLocaleTimeString()}.
          </p>
        ) : null}
      </div>
      <div className="flex justify-between">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onNewCode}
          disabled={busy !== null}
        >
          {busy === "code" ? <Spinner label="Restarting…" /> : "Get a new code"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRemove}
          disabled={busy !== null}
        >
          Cancel &amp; remove
        </Button>
      </div>
    </div>
  );
}

/**
 * A bridge is running for this workspace and the CRM holds no credentials for
 * it. There is no repair short of disconnecting: the app token existed once,
 * in the manager's provisioning 201, and no route mints another — so the QR
 * this bridge is offering would link a real number to a rail that can never
 * send. Only the control that works is offered, and no scan at all.
 */
export function OrphanPanel({
  onDisconnect,
  busy,
}: {
  onDisconnect: () => void;
  busy: BridgeBusy;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
        <p className="font-medium text-amber-800 dark:text-amber-300">
          This connection didn&apos;t finish
        </p>
        <p className="mt-2 text-amber-800/90 dark:text-amber-200/90">
          A bridge was created for this workspace but its credentials
          weren&apos;t saved, so it can&apos;t send or receive anything. Don&apos;t
          scan a code with it. Disconnect it and connect again — nothing is
          lost, but the number has to be paired from scratch.
        </p>
      </div>
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onDisconnect}
          disabled={busy !== null}
        >
          {busy === "disconnect" ? (
            <Spinner label="Disconnecting…" />
          ) : (
            "Disconnect and start over"
          )}
        </Button>
      </div>
    </div>
  );
}

/**
 * The bridge is up, nothing is paired, and no code is on offer — it has issued
 * its handful and stopped, or it has only just started. Both are ordinary and
 * both take the same button, so this says so instead of drawing a QR of
 * nothing.
 */
export function NoCodePanel({
  onNewCode,
  onRemove,
  busy,
}: {
  onNewCode: () => void;
  onRemove: () => void;
  busy: BridgeBusy;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-muted/30 p-4 text-sm">
        <p className="font-medium">No code available right now</p>
        <p className="mt-1 text-xs text-muted-foreground">
          This workspace has a bridge but nothing is paired to it and it
          isn&apos;t offering a code. It may still be starting up. Get a new
          code — this page keeps checking on its own for a while.
        </p>
      </div>
      <div className="flex justify-between">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onNewCode}
          disabled={busy !== null}
        >
          {busy === "code" ? <Spinner label="Restarting…" /> : "Get a new code"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRemove}
          disabled={busy !== null}
        >
          Cancel &amp; remove
        </Button>
      </div>
    </div>
  );
}

/** Paired. The number is only known once the bridge reports it back. */
export function ConnectedPanel({
  phoneNumber,
  onDisconnect,
  busy,
}: {
  phoneNumber: string | null;
  onDisconnect: () => void;
  busy: BridgeBusy;
}) {
  return (
    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
      <p className="text-sm text-emerald-700 dark:text-emerald-400">
        Connected
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        {phoneNumber ?? "The number confirms itself shortly after pairing."}
      </p>
      <div className="mt-3 flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onDisconnect}
          disabled={busy !== null}
        >
          {busy === "disconnect" ? (
            <Spinner label="Disconnecting…" />
          ) : (
            "Disconnect"
          )}
        </Button>
      </div>
    </div>
  );
}
