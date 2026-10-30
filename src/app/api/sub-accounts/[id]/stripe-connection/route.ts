import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import Stripe from "stripe";

import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { CUSTOM_BRAND } from "@/config/landing";
import { probeRestrictedKey } from "@/lib/stripe/sub-account-client";
import {
  RESTRICTED_KEY_RE,
  SECRET_KEY_RE,
  SUB_ACCOUNT_WEBHOOK_EVENTS,
  stripeConnectionSecretPath,
  type StripeConnectionMeta,
  type StripeConnectionSecret,
} from "@/types/payments";

/**
 * Connect / disconnect the sub-account's OWN Stripe account (Payments v1,
 * Tier 1). The operator pastes a Stripe RESTRICTED key; we store it in a
 * server-only subcollection and register a webhook endpoint on their account.
 *
 * POST   — body `{ restrictedKey }` or `{ webhookSecret }` (the manual
 *          fallback when the key can't create endpoints itself).
 * DELETE — disconnect: removes the remote endpoint best-effort, deletes the
 *          secret doc, clears the meta on the sub-account doc.
 *
 * SECURITY — the key NEVER goes on the sub-account doc. `subAccounts/{id}` is
 * readable by any active member (firestore.rules), and Firestore rules are
 * document-level, so a field there would be readable by every collaborator
 * seat. The secret lives at `subAccounts/{id}/private/stripeConnection`
 * (`allow read, write: if false`); only non-secret display metadata goes on
 * the doc. Nothing in a response body ever contains the key.
 *
 * Distinct from Client Billing's `/pay/*` routes, which charge the sub-account
 * on the AGENCY's Stripe. This is the sub-account charging ITS customers.
 */

interface PostBody {
  restrictedKey?: string;
  /** Manual fallback — set the signing secret for an endpoint the operator
   *  created by hand in their Stripe dashboard. */
  webhookSecret?: string;
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

/** `/api/webhooks/stripe/sa/{id}` — NOT `/api/webhooks/stripe`, which belongs
 *  to the agency's own Stripe (founders checkout, Client Billing, disputes). */
function webhookUrlFor(subAccountId: string): string | null {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!base) return null;
  return `${base}/api/webhooks/stripe/sa/${subAccountId}`;
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const subSnap = await subRef.get();
  if (!subSnap.exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  if (subSnap.data()?.paymentsEnabledByAgency !== true) return gateOff();

  const secretRef = db.doc(stripeConnectionSecretPath(subAccountId));

  // ── Manual webhook-secret paste (finishes a half-done connection) ────────
  if (typeof body.webhookSecret === "string" && !body.restrictedKey) {
    const webhookSecret = body.webhookSecret.trim();
    if (!webhookSecret.startsWith("whsec_")) {
      return NextResponse.json(
        { error: "Signing secrets start with `whsec_`. Copy it from the endpoint's page in your Stripe dashboard." },
        { status: 400 },
      );
    }
    const existing = await secretRef.get();
    if (!existing.exists) {
      return NextResponse.json(
        { error: "Connect a Stripe key first, then add the signing secret." },
        { status: 400 },
      );
    }
    await secretRef.set({ webhookSecret }, { merge: true });
    await subRef.set(
      {
        "stripeConnectionMeta.ready": true,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return NextResponse.json({ ok: true, ready: true });
  }

  // ── Connect a restricted key ─────────────────────────────────────────────
  const restrictedKey = (body.restrictedKey ?? "").trim();
  if (!restrictedKey) {
    return NextResponse.json(
      { error: "Paste your Stripe restricted key." },
      { status: 400 },
    );
  }
  if (SECRET_KEY_RE.test(restrictedKey)) {
    return NextResponse.json(
      {
        error:
          "That's a full secret key (sk_…), which can move money out of your account. Create a RESTRICTED key (rk_…) instead — Stripe → Developers → API keys → Create restricted key.",
      },
      { status: 400 },
    );
  }
  if (!RESTRICTED_KEY_RE.test(restrictedKey)) {
    return NextResponse.json(
      { error: "That doesn't look like a Stripe restricted key. It should start with `rk_live_` or `rk_test_`." },
      { status: 400 },
    );
  }

  const livemode = restrictedKey.startsWith("rk_live_");

  // Probe before storing — a bad key must not be persisted.
  let accountId: string | null = null;
  let accountName: string | null = null;
  try {
    ({ accountId, accountName } = await probeRestrictedKey(restrictedKey));
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError) {
      return NextResponse.json(
        { error: `Stripe rejected that key: ${err.message}` },
        { status: 400 },
      );
    }
    console.error("[stripe-connection] probe failed", err);
    return NextResponse.json(
      { error: "Couldn't reach Stripe to verify that key. Try again in a moment." },
      { status: 502 },
    );
  }

  // Register the webhook endpoint on THEIR account. Needs Webhook Endpoints
  // write on the restricted key; without it we fall back to a manual paste
  // rather than failing the whole connection.
  const url = webhookUrlFor(subAccountId);
  let webhookSecret = "";
  let webhookError: string | null = null;
  if (!url) {
    webhookError =
      "NEXT_PUBLIC_APP_URL isn't set on this deployment, so the webhook URL can't be built.";
  } else {
    try {
      const endpoint = await new Stripe(restrictedKey).webhookEndpoints.create({
        url,
        enabled_events: [...SUB_ACCOUNT_WEBHOOK_EVENTS],
        // WHITE-LABEL: this string shows up in the CLIENT's own Stripe
        // dashboard, so it must carry the buyer's brand — never a hardcoded
        // product name. CUSTOM_BRAND is the deployment's white-label identity.
        description: `${CUSTOM_BRAND.name} payments`,
      });
      webhookSecret = endpoint.secret ?? "";
      if (!webhookSecret) {
        webhookError = "Stripe created the endpoint but didn't return a signing secret.";
      }
    } catch (err) {
      webhookError =
        err instanceof Stripe.errors.StripeError
          ? err.message
          : "Couldn't create the webhook endpoint automatically.";
    }
  }

  const secret: StripeConnectionSecret = {
    mode: "key",
    restrictedKey,
    webhookSecret,
  };
  const meta: StripeConnectionMeta = {
    mode: "key",
    ready: !!webhookSecret,
    accountId,
    accountName,
    livemode,
    keyLast4: restrictedKey.slice(-4),
    connectedAt: new Date(),
  };

  await secretRef.set(secret);
  await subRef.set(
    { stripeConnectionMeta: meta, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );

  return NextResponse.json({
    ok: true,
    ready: meta.ready,
    accountId,
    accountName,
    livemode,
    // Present only when auto-registration failed — the UI shows the manual
    // fallback panel using these.
    webhookUrl: meta.ready ? null : url,
    webhookEvents: meta.ready ? null : [...SUB_ACCOUNT_WEBHOOK_EVENTS],
    webhookError,
  });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const secretRef = db.doc(stripeConnectionSecretPath(subAccountId));
  const snap = await secretRef.get();

  // Best-effort remote cleanup so we don't leave a dead endpoint retrying
  // against this deployment forever. Never blocks the disconnect.
  const data = snap.data() as Partial<StripeConnectionSecret> | undefined;
  const url = webhookUrlFor(subAccountId);
  if (data && (data.mode ?? "key") === "key") {
    const key = (data as { restrictedKey?: string }).restrictedKey;
    if (key && url) {
      try {
        const stripe = new Stripe(key);
        const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
        await Promise.all(
          endpoints.data
            .filter((e) => e.url === url)
            .map((e) => stripe.webhookEndpoints.del(e.id)),
        );
      } catch (err) {
        console.warn("[stripe-connection] endpoint cleanup failed", err);
      }
    }
  }

  await secretRef.delete();
  await db.doc(`subAccounts/${subAccountId}`).set(
    {
      stripeConnectionMeta: null,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return NextResponse.json({ ok: true });
}
