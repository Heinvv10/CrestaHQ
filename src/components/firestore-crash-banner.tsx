"use client";

import { useEffect, useRef, useState } from "react";
import { onLog } from "firebase/app";
import { Button } from "@/components/ui/button";
import { firestoreCrashMessage } from "@/lib/firebase/crash-signal";

/**
 * Once the Firestore SDK fails an internal assertion, every live view on the
 * page is frozen until a reload. Say so, at the top of every page, and offer
 * the reload — never do it unasked (it would lose unsaved input, and a crash
 * that recurs on load would loop). Not dismissable: nothing on the page
 * updates again until the reload.
 *
 * The crash reaches the page as an uncaught error, an unhandled rejection or
 * a line in the SDK's own logger; any one of them raises the banner, which
 * takes focus so the reload is one keypress away.
 */
export function FirestoreCrashBanner() {
  const [crashed, setCrashed] = useState(false);
  const reload = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let seen = false;
    const check = (value: unknown) => {
      const message = firestoreCrashMessage(value);
      if (!message || seen) return;
      seen = true;
      console.error(`[firestore] client crashed; asking for a reload: ${message}`);
      setCrashed(true);
    };
    const onError = (e: ErrorEvent) => check(e.error ?? e.message);
    const onRejection = (e: PromiseRejectionEvent) => check(e.reason);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    onLog(({ message }) => check(message), { level: "error" });
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      onLog(null);
    };
  }, []);

  useEffect(() => {
    if (crashed) reload.current?.focus();
  }, [crashed]);

  if (!crashed) return null;
  return (
    <div
      role="alert"
      data-testid="firestore-crash-banner"
      className="fixed inset-x-0 top-0 z-[100] flex flex-wrap items-center justify-center gap-3 bg-rose-600 px-4 py-2 text-sm text-white shadow"
    >
      <span>Connection to the server was lost. Reload to continue.</span>
      <Button ref={reload} type="button" size="sm" variant="secondary" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </div>
  );
}
