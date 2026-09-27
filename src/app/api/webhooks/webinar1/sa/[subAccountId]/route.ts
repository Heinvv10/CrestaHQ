import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { verifyWebhookSignature } from "@/lib/api/webhooks/signing";
import { readWebinar1ConnectionSecret } from "@/lib/webinar1/client";
import { logWebinarActivity } from "@/lib/webinar1/activities";
import { createContactServerSide } from "@/lib/server/contacts-service";
import type { ActivityType } from "@/types/contacts";
import type { SubAccountDoc } from "@/types";
import { isDocId } from "@/lib/server/doc-id";
import { readBodyCapped } from "@/lib/api/body-limit";

export const dynamic = "force-dynamic";

/**
 * Per-sub-account Webinar1 inbound webhook —
 * `POST /api/webhooks/webinar1/sa/{subAccountId}`.
 *
 * Registered on the connected Webinar1 deployment by the connect flow
 * (/api/sub-accounts/[id]/webinar1-connection). Security is the
 * `X-Webinar1-Signature` header — Stripe-style `t=<ts>,v1=<hmac>` over
 * `${ts}.${rawBody}`, the exact scheme of our own outbound webhooks, so
 * verification reuses lib/api/webhooks/signing.ts verbatim. The sub-account
 * id in the URL is untrusted routing info that only selects which stored
 * secret to verify against (same model as the per-SA Stripe receiver).
 *
 * Behavior per event (all carry `data.registration.email`):
 *  - registration.created → reconcile/create the contact by email, log
 *    `webinar_registered`.
 *  - attendee.joined / attendee.completed / cta.clicked → reconcile (create
 *    if somehow unseen), log the matching activity.
 *
 * Contract: 200 for everything except a signature failure — a non-2xx makes
 * Webinar1 retry with backoff and eventually auto-disable the endpoint.
 * Activity rows use deterministic ids so those retries can't double-log.
 */

interface Webinar1Envelope {
  id?: string;
  event?: string;
  createdAt?: string;
  data?: {
    webinar?: { id?: string; slug?: string; title?: string };
    registration?: {
      id?: string;
      email?: string;
      name?: string | null;
      maxWatchPercent?: number;
    };
    ctaUrl?: string;
  };
}

/**
 * Find the contact for this email within the sub-account, else create one.
 * Single-field equality on `email` (auto-indexed) + in-code tenancy filter —
 * the Meta receiver's composite-index-free reconcile pattern.
 */
async function reconcileContactByEmail(input: {
  subAccountId: string;
  agencyId: string;
  email: string;
  name: string | null;
  createIfMissing: boolean;
}): Promise<string | null> {
  const db = getAdminDb();
  const matches = await db
    .collection("contacts")
    .where("email", "==", input.email)
    .limit(10)
    .get();
  const existing = matches.docs.find(
    (d) => (d.data().subAccountId as string) === input.subAccountId
  );
  if (existing) return existing.id;
  if (!input.createIfMissing) return null;

  try {
    const created = await createContactServerSide({
      subAccountId: input.subAccountId,
      agencyId: input.agencyId,
      createdByUid: "webinar1-webhook",
      mode: "live",
      name: input.name ?? "",
      email: input.email,
      phone: "",
      company: "",
      address: "",
      source: "webinar",
      tags: [],
    });
    return created.id;
  } catch (err) {
    console.error(
      `[webhooks/webinar1] contact create failed sa=${input.subAccountId}`,
      err
    );
    return null;
  }
}

const EVENT_ACTIVITY: Record<string, { type: ActivityType; verb: string }> = {
  "registration.created": {
    type: "webinar_registered",
    verb: "Registered for",
  },
  "attendee.joined": { type: "webinar_joined", verb: "Joined" },
  "attendee.completed": {
    type: "webinar_completed",
    verb: "Watched to the end of",
  },
  "cta.clicked": {
    type: "webinar_cta_clicked",
    verb: "Clicked the offer in",
  },
};

export async function POST(
  request: Request,
  ctx: { params: Promise<{ subAccountId: string }> }
) {
  const { subAccountId } = await ctx.params;
  // Not a doc id: nothing can be configured there. Same answer as unconfigured.
  if (!isDocId(subAccountId)) return NextResponse.json({ ok: true, ignored: "not_configured" });
  // Provider events are a few KB; 1 MiB is generous and still bounded.
  const rawBody = await readBodyCapped(request, 1024 * 1024);
  if (rawBody === null) {
    console.warn(`[webhooks/webinar1] 413: body over the cap sa=${subAccountId} content-length=${request.headers.get("content-length")?.slice(0, 20) ?? "none"}`);
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }

  const secret = await readWebinar1ConnectionSecret(subAccountId);
  if (!secret?.webhookSecret) {
    // Unknown sub-account or half-connected (no signing secret yet): nothing
    // can be verified, so nothing is processed. 200 keeps a stale endpoint on
    // a disconnected deployment from retry-storming.
    return NextResponse.json({ ok: true, ignored: "not_configured" });
  }

  const verdict = verifyWebhookSignature({
    secret: secret.webhookSecret,
    rawBody,
    header: request.headers.get("x-webinar1-signature"),
  });
  if (!verdict.ok) {
    return NextResponse.json(
      { error: `Invalid signature (${verdict.reason})` },
      { status: 403 }
    );
  }

  let envelope: Webinar1Envelope;
  try {
    envelope = JSON.parse(rawBody) as Webinar1Envelope;
  } catch {
    return NextResponse.json({ ok: true, ignored: "bad_json" });
  }

  const mapping = envelope.event ? EVENT_ACTIVITY[envelope.event] : undefined;
  const registration = envelope.data?.registration;
  const email = registration?.email?.trim() ?? "";
  const registrationId = registration?.id ?? "";
  if (!mapping || !email || !registrationId) {
    // `ping`, future event types, or a payload we can't attribute — accepted
    // and dropped.
    return NextResponse.json({
      ok: true,
      ignored: envelope.event ?? "unknown",
    });
  }

  const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const sub = subSnap.data() as SubAccountDoc | undefined;
  if (!sub) {
    return NextResponse.json({ ok: true, ignored: "no_sub_account" });
  }
  // Agency gate — same warn-and-drop as the Meta receiver. 200 (not 403) so
  // the platform doesn't retry-storm and eventually auto-disable an endpoint
  // that will work again the moment the agency re-enables the feature.
  if (sub.webinar1EnabledByAgency !== true) {
    console.warn(
      `[webhooks/webinar1] event for sa=${subAccountId} but webinar1EnabledByAgency is off — dropping`
    );
    return NextResponse.json({ ok: true, ignored: "gate_off" });
  }

  const contactId = await reconcileContactByEmail({
    subAccountId,
    agencyId: sub.agencyId,
    email,
    name: registration?.name ?? null,
    createIfMissing: true,
  });
  if (!contactId) {
    return NextResponse.json({ ok: true, ignored: "contact_failed" });
  }

  const webinar = envelope.data?.webinar;
  const title = webinar?.title ?? "";
  const watch =
    envelope.event === "attendee.completed" &&
    typeof registration?.maxWatchPercent === "number"
      ? registration.maxWatchPercent
      : null;

  try {
    await logWebinarActivity(contactId, {
      type: mapping.type,
      content: `${mapping.verb} ${title ? `"${title}"` : "a webinar"}${
        watch !== null ? ` (${watch}% watched)` : ""
      }`,
      createdBy: "webinar1-webhook",
      meta: {
        ...(webinar?.id ? { webinarId: webinar.id } : {}),
        ...(webinar?.slug ? { webinarSlug: webinar.slug } : {}),
        webinarRegistrationId: registrationId,
        ...(watch !== null ? { webinarWatchPercent: watch } : {}),
      },
      // One row per (event type, registration): retries collapse, a repeat
      // CTA click stays a single timeline row, and a CRM-side push's echo
      // lands on the row the register route already wrote.
      dedupeKey: `${mapping.type}_${registrationId}`,
    });
  } catch (err) {
    // Log-and-200: activity rows are additive convenience; failing the
    // delivery would retry contact reconciliation too.
    console.error(
      `[webhooks/webinar1] activity write failed sa=${subAccountId}`,
      err
    );
  }

  return NextResponse.json({ ok: true });
}
