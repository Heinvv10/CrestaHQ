"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowRight,
  Check,
  Circle,
  CircleAlert,
  KeyRound,
  TriangleAlert,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

/**
 * Post-login setup snapshot for the agency owner.
 *
 * Ten seconds after the owner's session resolves, a dialog shows which
 * integrations are configured (email, SMS, AI voice, …) and which aren't,
 * with a deep link to Guided setup. It's aimed at brand-new owners who
 * otherwise discover a dark feature one screen at a time.
 *
 * Show rules (all must hold):
 *   • caller is the agency owner (never staff or clients),
 *   • they haven't ticked "Don't show this again" (persisted at
 *     users/{uid}/settings/setupSnapshot — the users/{uid} doc itself only
 *     lets the owner write displayName/photoURL/updatedAt — so it holds
 *     across devices),
 *   • it hasn't already been shown in this browser session (sessionStorage —
 *     so navigating around the dashboard doesn't re-open it, but the next
 *     sign-in does),
 *   • the summary endpoint answered (fail soft: no dialog beats a broken one).
 *
 * Reads the same counts+groups summary as the Get-started banner
 * (/api/agency/setup/summary — owner-gated, no key names or values).
 */

const OPEN_DELAY_MS = 10_000;
const SESSION_KEY = "setup-snapshot-shown";

/**
 * The show rule, minus the async parts (summary fetch, fail-soft). Owner only
 * — never staff or clients — once per browser session, and never after the
 * owner ticked "Don't show this again".
 */
export function shouldShowSetupSnapshot(state: {
  isOwner: boolean;
  shownThisSession: boolean;
  dismissed: boolean;
}): boolean {
  return state.isOwner && !state.shownThisSession && !state.dismissed;
}

function dismissalRef(uid: string) {
  return doc(getFirebaseDb(), `users/${uid}/settings/setupSnapshot`);
}

type GroupStatus = "ok" | "check" | "off" | "error";

interface SnapshotGroup {
  title: string;
  tier: string;
  status: GroupStatus;
  off: string | null;
}

interface SetupSummary {
  ok: boolean;
  requiredComplete: boolean;
  featuresConfigured: number;
  featuresTotal: number;
  groups: SnapshotGroup[];
}

/**
 * The integrations a new owner actually asks about, in the order they
 * matter. Anything else in the catalog is folded into "N more configured /
 * remaining" so the dialog stays a snapshot, not a doctor report.
 */
const HEADLINE_TITLES = [
  "Email",
  "SMS (Twilio)",
  "WhatsApp bridge fleet (wa-manager)",
  "AI replies (OpenRouter)",
  "AI Voice (Vapi)",
  "Automations + secure links (QStash)",
  "Billing (Stripe)",
  "Client Billing on Paystack (South Africa)",
  "Push notifications (PWA)",
  "Website builder (gitpage)",
  "Facebook + Instagram (Meta)",
  "Google (Business Profile + Calendar)",
];

/** Shorter labels for the dialog rows (the catalog titles carry vendor names). */
function shortLabel(title: string): string {
  switch (title) {
    case "SMS (Twilio)":
      return "SMS number";
    case "WhatsApp bridge fleet (wa-manager)":
      return "WhatsApp";
    case "Client Billing on Paystack (South Africa)":
      return "Client billing (Paystack)";
    case "Google (Business Profile + Calendar)":
      return "Google reviews & calendar";
    case "AI replies (OpenRouter)":
      return "AI agents & assistants";
    case "AI Voice (Vapi)":
      return "AI voice agent";
    case "Automations + secure links (QStash)":
      return "Workflows & scheduled steps";
    case "Billing (Stripe)":
      return "Subscription billing (Stripe)";
    case "Push notifications (PWA)":
      return "Mobile app push alerts";
    case "Website builder (gitpage)":
      return "Website builder";
    case "Facebook + Instagram (Meta)":
      return "Facebook & Instagram";
    default:
      return title;
  }
}

function StatusIcon({ status }: { status: GroupStatus }) {
  if (status === "ok") {
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
        <Check className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-rose-500/10 text-rose-600 dark:text-rose-400">
        <TriangleAlert className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (status === "check") {
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
        <CircleAlert className="h-3.5 w-3.5" />
      </span>
    );
  }
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
      <Circle className="h-3 w-3" />
    </span>
  );
}

function statusWord(status: GroupStatus): string {
  switch (status) {
    case "ok":
      return "Configured";
    case "check":
      return "Needs a check";
    case "error":
      return "Missing required keys";
    default:
      return "Not set up";
  }
}

export function SetupSnapshotDialog() {
  const { user, loading, agencyRole } = useAuth();
  const [summary, setSummary] = useState<SetupSummary | null>(null);
  const [open, setOpen] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);

  const isOwner = !loading && !!user && agencyRole === "owner";
  const uid = user?.uid;
  // Read at fire time (not an effect dep): a route change must neither
  // refetch nor restart the 10s timer.
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  useEffect(() => {
    if (!isOwner || !uid) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Once per browser session — a route change must not re-open it.
    let shownThisSession = false;
    try {
      shownThisSession = sessionStorage.getItem(SESSION_KEY) === "1";
    } catch {
      // Storage unavailable (private mode) — fall through and show once.
    }
    if (!shouldShowSetupSnapshot({ isOwner, shownThisSession, dismissed: false })) return;

    void (async () => {
      // Per-user "don't show again" lives in their own settings subcollection.
      try {
        const snap = await getDoc(dismissalRef(uid));
        const dismissed = snap.data()?.dismissed === true;
        if (cancelled || !shouldShowSetupSnapshot({ isOwner, shownThisSession, dismissed })) return;
      } catch {
        // Unreadable user doc — don't gamble on showing it.
        return;
      }
      let data: SetupSummary | null = null;
      try {
        const r = await fetch("/api/agency/setup/summary");
        data = r.ok ? ((await r.json()) as SetupSummary) : null;
      } catch {
        data = null;
      }
      if (cancelled || !data?.ok || !Array.isArray(data.groups)) return;
      setSummary(data);
      timer = setTimeout(() => {
        // Don't point the owner at the Guided setup page they're already on.
        if (cancelled || pathnameRef.current?.startsWith("/agency/setup")) return;
        setOpen(true);
        try {
          sessionStorage.setItem(SESSION_KEY, "1");
        } catch {
          // Shown once for this render at least.
        }
      }, OPEN_DELAY_MS);
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [isOwner, uid]);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next && dontShowAgain && user) {
      void setDoc(
        dismissalRef(user.uid),
        { dismissed: true, updatedAt: serverTimestamp() },
        { merge: true },
      ).catch(() => {
        // Best effort — the session flag still stops a re-open right now.
      });
    }
  }

  if (!summary) return null;

  const byTitle = new Map(summary.groups.map((g) => [g.title, g]));
  const headline = HEADLINE_TITLES.map((t) => byTitle.get(t)).filter(
    (g): g is SnapshotGroup => !!g,
  );
  const rest = summary.groups.filter(
    (g) => !HEADLINE_TITLES.includes(g.title) && g.tier === "feature",
  );
  const restConfigured = rest.filter((g) => g.status === "ok").length;
  const restRemaining = rest.length - restConfigured;
  const configured = summary.groups.filter(
    (g) => g.tier === "feature" && g.status === "ok",
  ).length;
  const total = summary.groups.filter((g) => g.tier === "feature").length;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/*
        Every wrapper down to the truncated "Off:" line carries min-w-0 /
        w-full / overflow-hidden so the dialog's own width wins. Without
        that, a grid-based DialogContent sizes its column to the longest
        description and the list + footer spill past the panel's edge
        (seen on a deployment running an older dialog primitive).
      */}
      <DialogContent className="w-[calc(100vw-2rem)] max-w-lg overflow-hidden sm:max-w-lg">
        <DialogHeader className="min-w-0">
          <DialogTitle>Your setup at a glance</DialogTitle>
          <DialogDescription>
            {summary.requiredComplete
              ? `Core setup is complete. ${configured} of ${total} integrations are configured — each one you add unlocks a feature.`
              : "Some required keys are still missing, so parts of the app can't run yet. Guided setup walks you through each one."}
          </DialogDescription>
        </DialogHeader>

        <ul className="max-h-[55vh] w-full min-w-0 divide-y overflow-y-auto overflow-x-hidden rounded-xl border">
          {headline.map((g) => (
            <li
              key={g.title}
              className="flex w-full min-w-0 items-center gap-3 px-3 py-2.5"
            >
              <StatusIcon status={g.status} />
              <div className="min-w-0 flex-1 overflow-hidden">
                <p className="truncate text-sm font-medium">
                  {shortLabel(g.title)}
                </p>
                {g.status !== "ok" && g.off && (
                  <p
                    className="truncate text-xs text-muted-foreground"
                    title={`Off: ${g.off}`}
                  >
                    Off: {g.off}
                  </p>
                )}
              </div>
              <span
                className={cn(
                  "shrink-0 whitespace-nowrap text-xs",
                  g.status === "ok"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : g.status === "error"
                      ? "text-rose-600 dark:text-rose-400"
                      : "text-muted-foreground",
                )}
              >
                {statusWord(g.status)}
              </span>
            </li>
          ))}
        </ul>
        {rest.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Plus {restConfigured} more configured and {restRemaining} more
            available — see them all in Guided setup.
          </p>
        )}

        <DialogFooter className="w-full min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <label className="flex min-w-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={dontShowAgain}
              onCheckedChange={(v) => setDontShowAgain(!!v)}
              aria-label="Don't show this again"
            />
            Don&apos;t show this again
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              render={<Link href="/agency/get-started" />}
              onClick={() => handleOpenChange(false)}
            >
              Get started
            </Button>
            <Button
              size="sm"
              render={<Link href="/agency/setup" />}
              onClick={() => handleOpenChange(false)}
            >
              <KeyRound className="mr-1 h-3.5 w-3.5" />
              Open Guided setup
              <ArrowRight className="ml-1 h-3 w-3" />
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
