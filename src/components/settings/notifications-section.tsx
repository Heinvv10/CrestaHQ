"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Bell, Loader2, Smartphone, Trash2 } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import {
  getNotificationPrefs,
  setSubAccountNotificationPref,
} from "@/lib/firestore/notification-prefs";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

/**
 * Push-notification settings (/me/settings). Three stacked blocks:
 *   1. This device — permission + subscribe flow, with explicit states for
 *      unsupported browsers, missing VAPID config, denied permission, and
 *      the iOS install-first requirement (Safari only delivers push to a
 *      home-screen-installed app).
 *   2. Registered devices — every browser this user enabled, with remove.
 *   3. Sub-accounts — per-membership on/off. Missing pref = ON (members
 *      are opt-out; see types/push.ts for the full semantics).
 */

type DeviceState =
  | "checking"
  | "unsupported"
  | "not-configured"
  | "ios-needs-install"
  | "denied"
  | "ready"
  | "subscribed";

interface DeviceRow {
  id: string;
  endpoint: string;
  userAgent: string | null;
}

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function deviceLabel(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const ua = userAgent;
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iPhone/iPad"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "Mac"
        : /Windows/.test(ua)
          ? "Windows"
          : "Device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : /Firefox\//.test(ua)
            ? "Firefox"
            : "browser";
  return `${os} · ${browser}`;
}

function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent);
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function NotificationsSection() {
  const { user, memberships, membershipsLoaded } = useAuth();
  const [state, setState] = useState<DeviceState>("checking");
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [currentEndpoint, setCurrentEndpoint] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  const refreshDevices = useCallback(async () => {
    try {
      const res = await fetch("/api/push/subscriptions");
      if (!res.ok) return;
      const data = (await res.json()) as { devices: DeviceRow[] };
      setDevices(data.devices ?? []);
    } catch {
      // Device list is cosmetic — leave whatever we had.
    }
  }, []);

  // Detect what this browser can do + whether it's already subscribed.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!VAPID_PUBLIC_KEY) return setState("not-configured");
      if (
        !("serviceWorker" in navigator) ||
        !("PushManager" in window) ||
        !("Notification" in window)
      ) {
        // iOS Safari hides the push APIs until the app is installed to the
        // home screen — surface the install hint instead of "unsupported".
        return setState(
          isIos() && !isStandalone() ? "ios-needs-install" : "unsupported",
        );
      }
      if (Notification.permission === "denied") return setState("denied");
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (cancelled) return;
        setCurrentEndpoint(sub?.endpoint ?? null);
        setState(sub ? "subscribed" : "ready");
      } catch {
        if (!cancelled) setState("ready");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  useEffect(() => {
    if (!user) return;
    getNotificationPrefs(user.uid)
      .then((p) => {
        setPrefs(p.subAccounts ?? {});
        setPrefsLoaded(true);
      })
      .catch(() => setPrefsLoaded(true));
  }, [user]);

  async function enableThisDevice() {
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "ready");
        if (permission === "denied") {
          toast.error(
            "Notifications are blocked for this site. Allow them in your browser's site settings, then try again.",
          );
        }
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        }));
      const res = await fetch("/api/push/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subscription: sub.toJSON(),
          userAgent: navigator.userAgent,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Failed to register this device");
      }
      setCurrentEndpoint(sub.endpoint);
      setState("subscribed");
      await refreshDevices();
      toast.success("Notifications enabled on this device");
    } catch (err) {
      console.error(err);
      toast.error(
        err instanceof Error ? err.message : "Couldn't enable notifications",
      );
    } finally {
      setBusy(false);
    }
  }

  async function disableThisDevice() {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/subscriptions", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setCurrentEndpoint(null);
      setState("ready");
      await refreshDevices();
      toast.success("Notifications disabled on this device");
    } catch (err) {
      console.error(err);
      toast.error("Couldn't disable notifications on this device");
    } finally {
      setBusy(false);
    }
  }

  async function removeDevice(device: DeviceRow) {
    try {
      await fetch("/api/push/subscriptions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: device.id }),
      });
      if (device.endpoint === currentEndpoint) {
        // Removing the row for THIS browser — drop the local subscription
        // too so the states can't disagree.
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        await sub?.unsubscribe();
        setCurrentEndpoint(null);
        setState("ready");
      }
      await refreshDevices();
    } catch {
      toast.error("Couldn't remove that device");
    }
  }

  async function togglePref(subAccountId: string, enabled: boolean) {
    if (!user) return;
    setPrefs((p) => ({ ...p, [subAccountId]: enabled }));
    try {
      await setSubAccountNotificationPref(user.uid, subAccountId, enabled);
    } catch {
      setPrefs((p) => ({ ...p, [subAccountId]: !enabled }));
      toast.error("Couldn't save that preference");
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-5">
      <div className="mb-4 flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
          <Bell className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-sm font-semibold">Notifications</h2>
          <p className="text-xs text-muted-foreground">
            Get a push the moment a lead, message, booking, or missed call
            comes in.
          </p>
        </div>
      </div>

      {/* This device */}
      <div className="rounded-lg border bg-background p-4">
        {state === "checking" && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking this
            device…
          </p>
        )}
        {state === "not-configured" && (
          <p className="text-sm text-muted-foreground">
            Push notifications aren&apos;t configured on this deployment yet.
            Ask whoever manages the deployment to set the VAPID keys
            (see the setup guide).
          </p>
        )}
        {state === "unsupported" && (
          <p className="text-sm text-muted-foreground">
            This browser doesn&apos;t support push notifications. Try Chrome,
            Edge, or Firefox — or install the app on your phone.
          </p>
        )}
        {state === "ios-needs-install" && (
          <div className="text-sm">
            <p className="font-medium">Install the app first</p>
            <p className="mt-1 text-xs text-muted-foreground">
              On iPhone and iPad, notifications only work once the app is on
              your home screen: open this site in Safari, tap the{" "}
              <span className="font-medium">Share</span> button, then{" "}
              <span className="font-medium">Add to Home Screen</span>. Open
              the installed app and come back to this page to enable
              notifications.
            </p>
          </div>
        )}
        {state === "denied" && (
          <p className="text-sm text-muted-foreground">
            Notifications are blocked for this site. Allow them in your
            browser&apos;s site settings (the lock icon next to the address
            bar), then reload this page.
          </p>
        )}
        {(state === "ready" || state === "subscribed") && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">
                {state === "subscribed"
                  ? "Notifications are on for this device"
                  : "Enable notifications on this device"}
              </p>
              <p className="text-xs text-muted-foreground">
                {state === "subscribed"
                  ? "You'll get a push for activity in the sub-accounts selected below."
                  : "Your browser will ask for permission."}
              </p>
            </div>
            <Button
              size="sm"
              variant={state === "subscribed" ? "outline" : "default"}
              disabled={busy}
              onClick={state === "subscribed" ? disableThisDevice : enableThisDevice}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : state === "subscribed" ? (
                "Disable"
              ) : (
                "Enable"
              )}
            </Button>
          </div>
        )}
      </div>

      {/* Registered devices */}
      {devices.length > 0 && (
        <div className="mt-3 space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Registered devices
          </p>
          {devices.map((d) => (
            <div
              key={d.id}
              className="flex items-center justify-between rounded-lg border bg-background px-3 py-2"
            >
              <span className="flex items-center gap-2 text-sm">
                <Smartphone className="h-3.5 w-3.5 text-muted-foreground" />
                {deviceLabel(d.userAgent)}
                {d.endpoint === currentEndpoint && (
                  <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                    This device
                  </span>
                )}
              </span>
              <button
                onClick={() => void removeDevice(d)}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Remove device"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Per-sub-account toggles */}
      <div className="mt-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Notify me about
        </p>
        {!membershipsLoaded || !prefsLoaded ? (
          <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
        ) : memberships.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            You aren&apos;t a member of any sub-accounts yet.
          </p>
        ) : (
          <div className="mt-2 space-y-1.5">
            {memberships.map((m) => {
              const enabled = prefs[m.subAccountId] !== false;
              return (
                <label
                  key={m.subAccountId}
                  className="flex cursor-pointer items-center justify-between rounded-lg border bg-background px-3 py-2"
                >
                  <span className="text-sm">{m.name}</span>
                  <Checkbox
                    checked={enabled}
                    onCheckedChange={(v) =>
                      void togglePref(m.subAccountId, v === true)
                    }
                  />
                </label>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
