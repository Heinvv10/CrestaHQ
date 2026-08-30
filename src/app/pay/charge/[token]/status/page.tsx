import { getAdminDb } from "@/lib/firebase/admin";
import { verifyChargeToken } from "@/lib/billing/token";
import { formatBillingPrice } from "@/lib/billing/status";

export const dynamic = "force-dynamic";

/**
 * Post-checkout landing for one-time charges — Stripe's success_url and
 * cancel_url both point here. Server-rendered with the Admin SDK so the
 * payer sees the LIVE charge status (webhook may lag a few seconds).
 *
 * Public route (under /pay in middleware PUBLIC_PATHS) — the HMAC token in
 * the URL is the credential, same as the /pay/charge entry itself. Note the
 * paid path can't use the token-hash check (paying clears `tokenHash`), so
 * it verifies the signature only and renders read-only status text.
 */

export default async function ChargeStatusPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ done?: string; cancelled?: string }>;
}) {
  const { token } = await params;
  const query = await searchParams;

  const verified = verifyChargeToken(token);
  let description: string | null = null;
  let amountLabel: string | null = null;
  let paid = false;

  if (verified) {
    const snap = await getAdminDb()
      .doc(`billingCharges/${verified.chargeId}`)
      .get();
    if (snap.exists) {
      const data = snap.data() ?? {};
      description = (data.description as string | undefined) ?? null;
      amountLabel = formatBillingPrice(
        data.amountCents as number | undefined,
        data.currency as string | undefined,
      );
      paid = data.status === "paid";
    }
  }

  const cancelled = query.cancelled === "1" && !paid;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="w-full max-w-md rounded-xl border bg-card p-8 text-center shadow-sm">
        {paid ? (
          <>
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-2xl dark:bg-emerald-900/40">
              ✓
            </div>
            <h1 className="text-xl font-semibold">Payment received</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {description ? `“${description}”` : "Your payment"}
              {amountLabel && amountLabel !== "—" ? ` (${amountLabel})` : ""} has
              been paid in full. A receipt has been sent to the email you used
              at checkout. You&apos;re all done — you can close this page.
            </p>
          </>
        ) : cancelled ? (
          <>
            <h1 className="text-xl font-semibold">Checkout not completed</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              No charge was made. You can pick up where you left off whenever
              you&apos;re ready.
            </p>
            <a
              href={`/pay/charge/${token}`}
              className="mt-6 inline-block rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Retry payment
            </a>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold">Processing payment…</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Confirming your payment — this usually takes a few seconds.
              Refresh this page to see the updated status.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
