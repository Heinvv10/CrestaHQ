import "server-only";

import { NextResponse } from "next/server";
import { FieldValue, type DocumentReference } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { BillingError } from "@/lib/billing/errors";
import { paystackKeyFingerprint } from "@/lib/paystack/key-fingerprint";
import { sweepOpenAttempts } from "@/lib/paystack/attempt-sweep";
import {
  probePaystackKey,
  readPaystackConnectionSecret,
} from "@/lib/paystack/sub-account-client";
import { flagStaleAttempts } from "@/lib/server/payment-attempts";
import {
  PAYSTACK_PUBLIC_KEY_RE,
  PAYSTACK_SECRET_KEY_RE,
  paystackConnectionSecretPath,
  type PaystackConnectionMeta,
  type PaystackConnectionSecret,
} from "@/types/paystack-connection";

/**
 * Connect / disconnect the sub-account's OWN Paystack account — the South
 * African card rail, and the Paystack twin of
 * `/api/sub-accounts/[id]/stripe-connection`.
 *
 * POST   — body `{ secretKey }`. Probed against Paystack before anything is
 *          stored, then written and the display metadata published.
 * DELETE — disconnect: deletes the secret doc, clears the meta.
 *
 * Before either replaces a key, the attempts still open under it are settled
 * or closed with that key while it is still stored (`sweepOpenAttempts`).
 * Once committed, every attempt still open under a different key is flagged
 * (`flagStaleAttempts`): its payment would be signed by a key this workspace
 * no longer holds, so it could never be recorded.
 *
 * SECURITY — the key NEVER goes on the sub-account doc. `subAccounts/{id}` is
 * readable by any active member (firestore.rules) and Firestore rules are
 * document-level, so a field there would be readable by every collaborator
 * seat. The secret lives at `subAccounts/{id}/private/paystackConnection`,
 * covered by the generic `match /private/{docId} { allow read, write: if
 * false }` rule — verified in firestore.rules, no rules deploy needed. No
 * response body ever contains the key.
 *
 * NO WEBHOOK IS REGISTERED HERE, and none can be: Paystack has no API to
 * create a webhook endpoint. The operator pastes the URL this route returns
 * into their Paystack dashboard by hand. See `PaystackConnectionMeta` for why
 * that means there is no `ready` boolean.
 */

interface PostBody {
  secretKey?: string;
}

function gateOff(): NextResponse {
  return NextResponse.json(
    {
      error:
        "Payments isn't enabled for this workspace. Ask your agency to turn it on.",
    },
    { status: 403 },
  );
}

/** `/api/webhooks/paystack/sa/{id}` — NOT `/api/webhooks/paystack`, which
 *  belongs to the agency's own Paystack (Client Billing). */
function webhookUrlFor(subAccountId: string): string | null {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!base) return null;
  return `${base}/api/webhooks/paystack/sa/${subAccountId}`;
}

/**
 * POST only. Disconnect is deliberately NOT gated — see DELETE.
 */
async function loadGatedSubAccount(
  subAccountId: string,
): Promise<NextResponse | { subRef: DocumentReference }> {
  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const subSnap = await subRef.get();
  if (!subSnap.exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  if (subSnap.data()?.paymentsEnabledByAgency !== true) return gateOff();
  return { subRef };
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const gated = await loadGatedSubAccount(subAccountId);
  if (gated instanceof NextResponse) return gated;

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const secretKey = (body.secretKey ?? "").trim();
  if (!secretKey) {
    return NextResponse.json(
      { error: "Paste your Paystack secret key." },
      { status: 400 },
    );
  }
  if (PAYSTACK_PUBLIC_KEY_RE.test(secretKey)) {
    return NextResponse.json(
      {
        error:
          "That's your PUBLIC key (pk_…), which can't authorise anything. Copy the SECRET key instead — Paystack → Settings → API Keys & Webhooks → Secret Key.",
      },
      { status: 400 },
    );
  }
  if (!PAYSTACK_SECRET_KEY_RE.test(secretKey)) {
    return NextResponse.json(
      {
        error:
          "That doesn't look like a Paystack secret key. It should start with `sk_live_` or `sk_test_`.",
      },
      { status: 400 },
    );
  }

  // Probe before storing — a key Paystack refuses must not be persisted, or
  // the workspace looks connected and every payment fails later.
  let currencies: string[];
  try {
    ({ currencies } = await probePaystackKey(secretKey));
  } catch (err) {
    if (err instanceof BillingError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      {
        error:
          "Couldn't reach Paystack to verify that key. Try again in a moment.",
      },
      { status: 502 },
    );
  }

  const webhookUrl = webhookUrlFor(subAccountId);
  const secret: PaystackConnectionSecret = { secretKey };
  const meta: PaystackConnectionMeta = {
    // Nothing has arrived yet by definition — the operator has not been shown
    // the URL until this response renders.
    webhookSeenAt: null,
    webhookUrl,
    currencies,
    livemode: secretKey.startsWith("sk_live_"),
    keyLast4: secretKey.slice(-4),
    connectedAt: new Date(),
  };

  const previous = await readPaystackConnectionSecret(subAccountId);
  if (previous && previous.secretKey !== secretKey) {
    await sweepOpenAttempts(subAccountId, previous.secretKey);
  }

  const db = getAdminDb();
  const batch = db.batch();
  batch.set(db.doc(paystackConnectionSecretPath(subAccountId)), secret);
  batch.set(
    db.doc(`subAccounts/${subAccountId}`),
    { paystackConnectionMeta: meta, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  await batch.commit();
  await flagStaleAttempts(subAccountId, paystackKeyFingerprint(secretKey));

  return NextResponse.json({
    ok: true,
    currencies,
    livemode: meta.livemode,
    webhookUrl,
  });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  // NOT gated on paymentsEnabledByAgency. Revoking a stored live secret key
  // must never depend on someone else re-enabling a feature first: an agency
  // that switches Payments off would otherwise strand the tenant holding a
  // credential it cannot remove. Connecting is gated; disconnecting is not.
  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  if (!(await subRef.get()).exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  const previous = await readPaystackConnectionSecret(subAccountId);
  if (previous) await sweepOpenAttempts(subAccountId, previous.secretKey);

  // ONE batch, not two awaits. Clearing the meta first and deleting the key
  // second leaves a window in which a retried Paystack webhook still finds the
  // secret, verifies, and stamps `paystackConnectionMeta.webhookSeenAt` — a
  // dotted-path update over a null parent recreates the map, so the card would
  // then show "Connected" for a tenant whose key is gone, permanently.
  const batch = db.batch();
  batch.set(
    subRef,
    {
      paystackConnectionMeta: null,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  batch.delete(db.doc(paystackConnectionSecretPath(subAccountId)));
  await batch.commit();
  await flagStaleAttempts(subAccountId, null);

  return NextResponse.json({ ok: true });
}
