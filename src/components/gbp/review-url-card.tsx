"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { listingFor } from "@/lib/gbp/listings";
import { resolveReviewUrl } from "@/lib/reviews/canonical-url";

/**
 * Review-request link reconciliation (admins). The selected GBP listing's
 * review link is only ever PROPOSED: the configured link — the one review
 * requests send — changes only when the admin clicks, as a compare-and-set on
 * the link shown here (POST …/google-review/adopt-listing-url). Reads the live
 * sub-account doc, but once adopted it shows the result from the route's 200,
 * not the doc's next snapshot (Firestore's Listen stream can sit silent ~30 s
 * after a write, leaving "no link yet" beside a successful adopt). No confirm().
 *
 * With `locationName` (an EXTRA listing, MULTI_LISTING_V1_PLAN.md PR 5) the
 * card is that listing's: its own link, adopted into its own key, test ids
 * prefixed `gbp-listing-reviewurl-` and tagged `data-location`.
 */
export function ReviewUrlCard({ locationName }: { locationName?: string }) {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();
  const [pending, setPending] = useState(false);
  // What the route said it adopted, and the configured link it replaced: it
  // holds only while the doc still shows that link and that proposal (a
  // snapshot has not landed), and is dropped the moment it moves off either —
  // so a link or proposal later reset to those values is not mistaken for this
  // adopt. (Set during render: React restarts the render before anything is
  // committed.)
  const [adopted, setAdopted] = useState<{ from: string | null; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = resolveReviewUrl(subAccount, locationName);
  if (adopted && (live.configured !== adopted.from || live.proposed !== adopted.url)) setAdopted(null);
  const { configured, proposed, state } = adopted ? { ...live, configured: adopted.url, state: "matches" as const } : live;
  const tid = locationName ? "gbp-listing-reviewurl" : "gbp-reviewurl";
  const title = locationName && subAccount ? (listingFor(subAccount, locationName)?.title ?? "This listing") : null;

  // Admins only, and not while the agency gate is off (the adopt route refuses then).
  if (!isAdmin || subAccount?.googleEnabledByAgency !== true || state === "none") return null;
  if (state === "matches") {
    return (
      <p className="mt-3 text-xs text-muted-foreground" data-testid={`${tid}-matches`} data-location={locationName}>
        {title ? `Review requests for ${title} use its review link.` : <>Review requests use this listing&apos;s review link.</>}
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
        body: JSON.stringify(locationName ? { expectedCurrentUrl: configured, locationName } : { expectedCurrentUrl: configured }),
      });
      const data = (await res.json().catch(() => null)) as { code?: string; currentUrl?: string | null; error?: string; reviewUrl?: string } | null;
      if (res.ok && data?.reviewUrl) setAdopted({ from: configured, url: data.reviewUrl });
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
    <div className="mt-4 space-y-2 rounded-xl border p-3 text-sm" data-testid={`${tid}-proposal`} data-state={state} data-location={locationName}>
      {title ? (
        state === "differs" ? (
          <p>
            Review requests for {title} send <code className="break-all">{configured}</code>. Its Google review link
            is <code className="break-all">{proposed}</code>.
          </p>
        ) : (
          <p>
            {title}&apos;s Google review link is <code className="break-all">{proposed}</code> — review requests for it
            have no link yet.
          </p>
        )
      ) : state === "differs" ? (
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
      <Button type="button" size="sm" variant="outline" onClick={adopt} disabled={pending} data-testid={`${tid}-adopt`}>
        {pending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
        {state === "differs" ? "Replace with listing link" : "Use it"}
      </Button>
      {error && (
        <p className="text-xs text-red-600" role="alert" data-testid={`${tid}-error`}>{error}</p>
      )}
    </div>
  );
}
