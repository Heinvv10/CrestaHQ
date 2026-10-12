"use client";

import { useEffect, useRef, useState } from "react";
import {
  Grip,
  Loader2,
  Mic,
  MicOff,
  PhoneOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Contact } from "@/types/contacts";

/**
 * Softphone v1 — the floating in-call bar. Mounted by the contact profile's
 * Call button; one instance per call. Flow: fetch a scoped AccessToken →
 * dynamically import @twilio/voice-sdk (keeps it out of the main bundle) →
 * `device.connect({ params: { contactId } })` → Twilio hits our TwiML App
 * webhook, which dials the contact's phone server-side. The browser only ever
 * holds the short-TTL JWT, in memory: it is never logged or stored.
 *
 * Ours differs from upstream in how a call ends. Every way out — a refused
 * token, a device or call error, the call ending, Hang up, unmount — goes
 * through one place that disconnects the call and destroys the Device, and
 * the first outcome wins. Hang up never waits for an SDK event, so no answer
 * from the token route and no missing event can leave the bar "calling".
 * NOT runtime-verified against a real Twilio account (docs/features/dialer.md).
 */

type CallPhase = "connecting" | "ringing" | "in-call" | "ended" | "error";

/** Structural types for the dynamically-imported SDK (avoids hard type dep). */
interface VoiceCall {
  on(event: string, handler: (...args: unknown[]) => void): void;
  mute(shouldMute: boolean): void;
  isMuted(): boolean;
  sendDigits(digits: string): void;
  disconnect(): void;
}
interface VoiceDevice {
  connect(opts: { params: Record<string, string> }): Promise<VoiceCall>;
  destroy(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

const KEYPAD = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

function sdkErrorMessage(e: unknown): string {
  return e && typeof e === "object" && "message" in e
    ? String((e as { message: unknown }).message)
    : "Call failed.";
}

/**
 * Ask the token route for a call token. Every answer it can give — 403
 * (locked by the agency, not a member, dialer or Twilio off), 404, 5xx with
 * or without a JSON body, a login redirect, a dropped connection — comes back
 * as a message to show; only a 2xx carrying a token is a token.
 */
async function requestToken(
  subAccountId: string,
): Promise<{ token: string } | { error: string }> {
  let res: Response;
  try {
    res = await fetch("/api/comms/dialer/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subAccountId }),
    });
  } catch {
    return { error: "Couldn't reach the server. Check your connection and try again." };
  }
  const data = (await res.json().catch(() => ({}))) as {
    ok?: unknown;
    token?: unknown;
    error?: unknown;
  } | null;
  if (res.ok && data?.ok === true && typeof data.token === "string" && data.token) {
    return { token: data.token };
  }
  return {
    error:
      typeof data?.error === "string" && data.error
        ? data.error
        : "Couldn't authorize the call.",
  };
}

export function BrowserCallBar({
  contact,
  subAccountId,
  onClose,
}: {
  contact: Contact;
  subAccountId: string;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<CallPhase>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [showKeypad, setShowKeypad] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const deviceRef = useRef<VoiceDevice | null>(null);
  const callRef = useRef<VoiceCall | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True once this call has an outcome. Destroying the Device makes the SDK
  // emit "disconnect", which must not turn a shown error into "Call ended".
  const settledRef = useRef(false);

  /** Disconnect the call and destroy the Device. Safe to call twice. */
  function teardown() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    const call = callRef.current;
    const device = deviceRef.current;
    callRef.current = null;
    deviceRef.current = null;
    try {
      call?.disconnect();
    } finally {
      device?.destroy();
    }
  }

  /** The one way a call reaches "ended" or "error". First outcome wins. */
  function settle(next: "ended" | "error", message?: string) {
    if (settledRef.current) return;
    settledRef.current = true;
    teardown();
    if (next === "error") setError(message ?? null);
    setPhase(next);
    if (next === "ended") closeTimerRef.current = setTimeout(onClose, 2500);
  }

  useEffect(() => {
    let cancelled = false;
    settledRef.current = false;
    // Nothing from this run — an SDK event included — acts after its cleanup.
    const finish = (next: "ended" | "error", message?: string) => {
      if (!cancelled) settle(next, message);
    };

    async function start() {
      try {
        const answer = await requestToken(subAccountId);
        if (cancelled) return;
        if ("error" in answer) {
          finish("error", answer.error);
          return;
        }

        const { Device } = await import("@twilio/voice-sdk");
        if (cancelled) return;
        const device = new Device(answer.token) as unknown as VoiceDevice;
        deviceRef.current = device;
        device.on("error", (e) => finish("error", sdkErrorMessage(e)));

        setPhase("ringing");
        const call = await device.connect({
          params: { contactId: contact.id },
        });
        // Unmounted, or the Device failed, while the call was being set up.
        if (cancelled || settledRef.current) {
          call.disconnect();
          return;
        }
        callRef.current = call;
        call.on("accept", () => {
          if (cancelled || settledRef.current) return;
          setPhase("in-call");
          timerRef.current = setInterval(
            () => setSeconds((s) => s + 1),
            1000,
          );
        });
        call.on("disconnect", () => finish("ended"));
        call.on("cancel", () => finish("ended"));
        call.on("error", (e) => finish("error", sdkErrorMessage(e)));
      } catch (err) {
        finish(
          "error",
          err instanceof Error ? err.message : "Couldn't start the call.",
        );
      }
    }

    void start();
    return () => {
      cancelled = true;
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contact.id, subAccountId]);

  function toggleMute() {
    const call = callRef.current;
    if (!call) return;
    const next = !call.isMuted();
    call.mute(next);
    setMuted(next);
  }

  function hangUp() {
    // An answered call ends here and now, not when the SDK says so. In every
    // other phase there is nothing to show after it: close, and unmounting
    // cancels whatever is still being set up.
    if (phase === "in-call") settle("ended");
    else onClose();
  }

  const mm = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, "0");
  const statusLine =
    phase === "connecting"
      ? "Connecting…"
      : phase === "ringing"
        ? "Ringing…"
        : phase === "in-call"
          ? `${mm}:${ss}`
          : phase === "ended"
            ? "Call ended"
            : (error ?? "Call failed");

  return (
    <div
      className="fixed bottom-4 right-4 z-50 w-72 rounded-2xl border bg-card p-4 shadow-xl"
      data-testid="browser-call-bar"
      data-phase={phase}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">
            {contact.name || contact.phone}
          </p>
          <p
            className={cn(
              "text-xs",
              phase === "error"
                ? "text-destructive"
                : phase === "in-call"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground",
            )}
            data-testid="browser-call-status"
          >
            {statusLine}
          </p>
        </div>
        {(phase === "connecting" || phase === "ringing") && (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        )}
      </div>

      {showKeypad && phase === "in-call" && (
        <div className="mt-3 grid grid-cols-3 gap-1.5">
          {KEYPAD.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => callRef.current?.sendDigits(d)}
              className="rounded-lg border bg-background py-1.5 text-sm font-medium hover:bg-muted"
            >
              {d}
            </button>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center justify-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={toggleMute}
          disabled={phase !== "in-call"}
          title={muted ? "Unmute" : "Mute"}
        >
          {muted ? (
            <MicOff className="h-3.5 w-3.5" />
          ) : (
            <Mic className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setShowKeypad((v) => !v)}
          disabled={phase !== "in-call"}
          title="Keypad"
        >
          <Grip className="h-3.5 w-3.5" />
        </Button>
        {phase === "ended" ? (
          <Button type="button" size="sm" variant="outline" onClick={onClose}>
            Close
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={hangUp}
          >
            <PhoneOff className="mr-1 h-3.5 w-3.5" />
            {phase === "error" ? "Close" : "Hang up"}
          </Button>
        )}
      </div>
    </div>
  );
}
