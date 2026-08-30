import Link from "next/link";
import { getAdminDb } from "@/lib/firebase/admin";
import { verifyCheckoutToken } from "@/lib/billing/token";

export const dynamic = "force-dynamic";

/**
 * Post-checkout landing for the public /pay flow (Client Billing v1) —
 * Stripe's success_url and cancel_url both point here. Server-rendered
 * with the Admin SDK so the buyer sees the LIVE billing status: if the
 * webhook already flipped the workspace active, they're told to log in;
 * if not (webhook lag or a cancelled checkout), they get a retry link.
 *
 * Public route (under /pay in middleware PUBLIC_PATHS) — the HMAC token in
 * the URL is the credential, same as /pay/[token] itself.
 */

export default async function PayStatusPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ done?: string; cancelled?: string }>;
}) {
  const { token } = await params;
  const query = await searchParams;

  const verified = verifyCheckoutToken(token);
  let workspaceName: string | null = null;
  let planName: string | null = null;
  let active = false;

  if (verified) {
    const snap = await getAdminDb()
      .doc(`subAccounts/${verified.subAccountId}`)
      .get();
    if (snap.exists) {
      const data = snap.data() ?? {};
      workspaceName = (data.name as string | undefined) ?? null;
      const billing = data.billing as
        | { status?: string; planName?: string | null }
        | undefined;
      planName = billing?.planName ?? null;
      active = billing?.status === "active";
    }
  }

  const cancelled = query.cancelled === "1" && !active;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="w-full max-w-md rounded-xl border bg-card p-8 text-center shadow-sm">
        {active ? (
          <>
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-2xl dark:bg-emerald-900/40">
              ✓
            </div>
            <h1 className="text-xl font-semibold">
              {workspaceName ? `${workspaceName} is active` : "Subscription active"}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {planName ? `Your ${planName} subscription is live. ` : ""}
              You&apos;re all set — log in to your workspace to get started.
            </p>
            <Link
              href="/login"
              className="mt-6 inline-block rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Log in
            </Link>
          </>
        ) : cancelled ? (
          <>
            <h1 className="text-xl font-semibold">Checkout not completed</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              No charge was made. You can pick up where you left off whenever
              you&apos;re ready.
            </p>
            <a
              href={`/pay/${token}`}
              className="mt-6 inline-block rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Retry payment
            </a>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold">Payment received</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              We&apos;re activating your workspace — this usually takes a few
              seconds. Refresh this page, or log in and you&apos;ll be up and
              running shortly.
            </p>
            <Link
              href="/login"
              className="mt-6 inline-block rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Log in
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
