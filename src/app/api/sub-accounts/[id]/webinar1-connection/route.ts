import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  Webinar1ConnectionError,
  getWebinar1ClientForCredentials,
  readWebinar1ConnectionSecret,
} from "@/lib/webinar1/client";
import { webinar1GateOffResponse, webinar1GateOn } from "@/lib/webinar1/gate";
import {
  WEBINAR1_SUBSCRIBED_EVENTS,
  webinar1ConnectionSecretPath,
  type Webinar1ConnectionMeta,
  type Webinar1ConnectionSecret,
} from "@/types/webinar1";

/**
 * Connect / disconnect a sub-account's Webinar1 deployment.
 *
 * POST   — body `{ baseUrl, apiKey }` or `{ webhookSecret }` (the manual
 *          fallback when webhook auto-registration failed).
 * DELETE — disconnect: removes the remote webhook endpoint best-effort,
 *          deletes the secret doc, clears the meta on the sub-account doc.
 *
 * Same shape as the Stripe connection route: probe the credentials before
 * storing anything, auto-register OUR webhook receiver on THEIR deployment
 * (Webinar1's `POST /v1/webhook-endpoints` returns the signing secret once),
 * secret in `private/` (Admin SDK only), display metadata on the doc.
 */

interface PostBody {
  baseUrl?: string;
  apiKey?: string;
  /** Manual fallback — signing secret for an endpoint created by hand in
   *  Webinar1 → Settings → Webhooks. */
  webhookSecret?: string;
}

function webhookUrlFor(subAccountId: string): string | null {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!base) return null;
  return `${base}/api/webhooks/webinar1/sa/${subAccountId}`;
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;
  // Agency gate — connecting (or finishing a connection) is blocked while
  // off. Disconnect (DELETE) stays ungated so cleanup is always possible.
  if (!(await webinar1GateOn(subAccountId))) return webinar1GateOffResponse();

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const secretRef = db.doc(webinar1ConnectionSecretPath(subAccountId));

  // ── Manual webhook-secret paste (finishes a half-done connection) ────────
  if (typeof body.webhookSecret === "string" && !body.apiKey) {
    const webhookSecret = body.webhookSecret.trim();
    if (!webhookSecret.startsWith("whsec_")) {
      return NextResponse.json(
        {
          error:
            "Signing secrets start with `whsec_`. Copy it from Settings → Webhooks on your webinar platform.",
        },
        { status: 400 }
      );
    }
    const existing = await secretRef.get();
    if (!existing.exists) {
      return NextResponse.json(
        {
          error:
            "Connect the webinar platform first, then add the signing secret.",
        },
        { status: 400 }
      );
    }
    await secretRef.set({ webhookSecret }, { merge: true });
    await subRef.set(
      {
        "webinar1ConnectionMeta.webhookReady": true,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return NextResponse.json({ ok: true, webhookReady: true });
  }

  // ── Connect base URL + API key ───────────────────────────────────────────
  const baseUrl = (body.baseUrl ?? "").trim().replace(/\/+$/, "");
  const apiKey = (body.apiKey ?? "").trim();
  if (!baseUrl || !apiKey) {
    return NextResponse.json(
      { error: "Both the platform URL and an API key are required." },
      { status: 400 }
    );
  }
  let origin: URL;
  try {
    origin = new URL(baseUrl);
  } catch {
    return NextResponse.json(
      {
        error:
          "That doesn't look like a URL. Use the deployment's origin, e.g. https://webinars.yourdomain.com",
      },
      { status: 400 }
    );
  }
  const isLocalhost =
    origin.hostname === "localhost" || origin.hostname === "127.0.0.1";
  if (origin.protocol !== "https:" && !isLocalhost) {
    return NextResponse.json(
      { error: "The platform URL must be https." },
      { status: 400 }
    );
  }
  if (!apiKey.startsWith("wbk_")) {
    return NextResponse.json(
      {
        error:
          "API keys start with `wbk_`. Create one on your webinar platform under Settings → API.",
      },
      { status: 400 }
    );
  }

  // Probe before storing — a bad URL/key must not be persisted. Listing
  // webinars is the cheapest authenticated call.
  const client = getWebinar1ClientForCredentials(baseUrl, apiKey);
  try {
    await client.listWebinars();
  } catch (err) {
    const message =
      err instanceof Webinar1ConnectionError
        ? err.status === 401
          ? "The platform rejected that API key. Check it wasn't revoked or disabled."
          : err.message
        : "Couldn't verify the connection.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // Register OUR receiver on THEIR deployment. Failure (no public app URL in
  // dev, SSRF-rejected URL, older Webinar1 build without the endpoint API)
  // falls back to a manual paste rather than failing the whole connection.
  const url = webhookUrlFor(subAccountId);
  let webhookSecret = "";
  let webhookEndpointId: string | null = null;
  let webhookError: string | null = null;
  if (!url) {
    webhookError =
      "NEXT_PUBLIC_APP_URL isn't set on this deployment, so the webhook URL can't be built.";
  } else {
    try {
      const endpoint = await client.createWebhookEndpoint({
        url,
        events: WEBINAR1_SUBSCRIBED_EVENTS,
        description: "LeadStack CRM",
      });
      webhookSecret = endpoint.secret ?? "";
      webhookEndpointId = endpoint.id ?? null;
      if (!webhookSecret) {
        webhookError =
          "The platform created the endpoint but didn't return a signing secret.";
      }
    } catch (err) {
      webhookError =
        err instanceof Webinar1ConnectionError
          ? err.message
          : "Couldn't create the webhook endpoint automatically.";
    }
  }

  const secret: Webinar1ConnectionSecret = {
    baseUrl,
    apiKey,
    webhookSecret,
    webhookEndpointId,
  };
  const meta: Webinar1ConnectionMeta = {
    baseUrl,
    keyPrefix: apiKey.slice(0, 12),
    webhookReady: !!webhookSecret,
    connectedAt: new Date(),
  };

  await secretRef.set(secret);
  await subRef.set(
    { webinar1ConnectionMeta: meta, updatedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );

  return NextResponse.json({
    ok: true,
    webhookReady: meta.webhookReady,
    // Present only when auto-registration failed — the UI shows the manual
    // fallback panel using these.
    webhookUrl: meta.webhookReady ? null : url,
    webhookEvents: meta.webhookReady ? null : [...WEBINAR1_SUBSCRIBED_EVENTS],
    webhookError,
  });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const secret = await readWebinar1ConnectionSecret(subAccountId);

  // Best-effort remote cleanup so the platform doesn't keep retrying
  // deliveries against a dead receiver. Never blocks the disconnect.
  if (secret?.webhookEndpointId) {
    try {
      await getWebinar1ClientForCredentials(
        secret.baseUrl,
        secret.apiKey
      ).deleteWebhookEndpoint(secret.webhookEndpointId);
    } catch (err) {
      console.warn("[webinar1-connection] endpoint cleanup failed", err);
    }
  }

  await db.doc(webinar1ConnectionSecretPath(subAccountId)).delete();
  await db.doc(`subAccounts/${subAccountId}`).set(
    {
      webinar1ConnectionMeta: null,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return NextResponse.json({ ok: true });
}
