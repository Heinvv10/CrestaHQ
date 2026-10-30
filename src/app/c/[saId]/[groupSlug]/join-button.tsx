"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { PurchaseButton } from "@/components/community/purchase-button";

type MemberState = "guest" | "member" | "joined" | "pending";

/**
 * Public group About-page CTA. Behavior depends on the viewer:
 *  - guest (no session) → links to the member login
 *  - member (signed in, not joined) → POSTs the join endpoint
 *  - joined → enters the group (the feed, or the classroom in courses mode)
 *  - pending → shows awaiting-approval state
 * Labels + the enter destination come from the server component so the same
 * button sells a community ("Join group") or a course ("Get access").
 */
export function JoinButton({
  saId,
  groupId,
  state,
  access,
  joinLabel,
  enterHref,
  enterLabel,
  brandColor,
}: {
  saId: string;
  groupId: string;
  state: MemberState;
  access: "free" | "paid";
  joinLabel: string;
  enterHref: string;
  enterLabel: string;
  brandColor: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const style = { backgroundColor: brandColor, color: "#fff" } as const;
  const base =
    "inline-flex w-full items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-semibold shadow-sm transition-opacity hover:opacity-90 disabled:opacity-60";

  if (state === "joined") {
    return (
      <a href={enterHref} className={base} style={style}>
        {enterLabel}
      </a>
    );
  }

  if (state === "pending") {
    return (
      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 text-center text-sm text-amber-700">
        Your request to join is awaiting approval.
      </div>
    );
  }

  if (state === "guest") {
    return (
      <a
        href={`/c/${saId}/login?join=${encodeURIComponent(groupId)}`}
        className={base}
        style={style}
      >
        {joinLabel}
      </a>
    );
  }

  // state === "member" (signed in, not yet joined). Paid groups go through the
  // one-time purchase flow; free groups join directly.
  if (access === "paid") {
    return (
      <PurchaseButton
        saId={saId}
        groupId={groupId}
        scope="group"
        targetId={groupId}
        label={joinLabel}
        brand={brandColor}
        className={base}
      />
    );
  }

  async function handleJoin() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/community/${saId}/${groupId}/join`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        status?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Couldn't join");
      if (data.status === "active") {
        router.push(enterHref);
        router.refresh();
      } else if (data.status === "payment_required") {
        setError("This group requires payment — coming soon.");
      } else {
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't join");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <button onClick={handleJoin} disabled={busy} className={base} style={style}>
        {busy ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Joining…
          </>
        ) : (
          joinLabel
        )}
      </button>
      {error && <p className="text-center text-xs text-destructive">{error}</p>}
    </div>
  );
}
