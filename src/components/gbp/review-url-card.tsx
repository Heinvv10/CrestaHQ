"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { resolveReviewUrl } from "@/lib/reviews/canonical-url";

/**
 * Review-request link reconciliation (admins). The selected GBP listing's
 * review link is only ever PROPOSED: the configured link — the one review
 * requests send — changes only when the admin clicks, as a compare-and-set on
 * the link shown here (POST …/google-review/adopt-listing-url). Reads the live
 * sub-account doc, so the card updates itself once adopted. No confirm().
 */
export function ReviewUrlCard() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { configured, proposed, state } = resolveReviewUrl(subAccount);

  // Admins only, and not while the agency gate is off (the adopt route refuses then).
  if (!isAdmin || subAccount?.googleEnabledByAgency !== true || state === "none") return null;
  if (state === "matches") {
    return (
      <p className="mt-3 text-xs text-muted-foreground" data-testid="gbp-reviewurl-matches">
        Review requests use this listing&apos;s review link.
      </p>
    );
  }

  const adopt = async () => {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/google-review/adopt-listing-url`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedCurrentUrl: configured }),
      });
      const data = (await res.json().catch(() => null)) as { code?: string; currentUrl?: string | null; error?: string } | null;
      if (res.ok) setDone(true);
      else if (data?.code === "changed") {
        setError(`The review link changed since you looked — it is now ${data.currentUrl ?? "empty"}. Check it and try again.`);
      } else setError(data?.error ?? "That didn't work. Please try again.");
    } catch (err) {
      console.warn(`[gbp/review-url] adopt failed: ${err instanceof Error ? err.name : typeof err}`);
      setError("That didn't work. Please try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mt-4 space-y-2 rounded-xl border p-3 text-sm" data-testid="gbp-reviewurl-proposal" data-state={state}>
      {state === "differs" ? (
        <p>
          Review requests currently send <code className="break-all">{configured}</code>. Your selected Google
          listing&apos;s review link is <code className="break-all">{proposed}</code>.
        </p>
      ) : (
        <p>
          Your selected Google listing&apos;s review link is <code className="break-all">{proposed}</code> — review
          requests have no link yet.
        </p>
      )}
      {done ? (
        <p className="text-xs text-emerald-700 dark:text-emerald-400" role="status" data-testid="gbp-reviewurl-done">
          Review requests now use the listing&apos;s link.
        </p>
      ) : (
        <Button type="button" size="sm" variant="outline" onClick={adopt} disabled={pending} data-testid="gbp-reviewurl-adopt">
          {pending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
          {state === "differs" ? "Replace with listing link" : "Use it"}
        </Button>
      )}
      {error && (
        <p className="text-xs text-red-600" role="alert" data-testid="gbp-reviewurl-error">{error}</p>
      )}
    </div>
  );
}
