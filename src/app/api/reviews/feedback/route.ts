import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { checkCheckoutRateLimit, clientIpFrom } from "@/lib/checkout/rate-limit";
import { verifyReviewToken } from "@/lib/reviews/feedback-token";
import { createTaskServerSide } from "@/lib/server/tasks-service";
import {
  REVIEW_COMMENT_MAX,
  REVIEW_FOLLOW_UP_THRESHOLD,
  REVIEW_PII_RETENTION_DAYS,
} from "@/types/review-feedback";

/**
 * PUBLIC endpoint — anyone holding a valid `/r/[token]` link can POST here.
 * There is no session; the signed token IS the authorisation, and tenancy is
 * stamped from the contact server-side so a caller can never write into
 * another sub-account.
 *
 * Records an optional star rating + comment, and opens an internal follow-up
 * task when the rating is low.
 *
 * The token check and the token burn happen inside a single Firestore
 * transaction along with the feedback write, so two concurrent requests
 * carrying the same still-valid token cannot both succeed — the second reads
 * the already-cleared `reviewTokenHash` and is rejected. Same shape as the
 * public quote respond route, and for the same reason.
 *
 * COMPLIANCE: this endpoint never decides whether the customer sees the Google
 * review link — the page shows it to everyone, before and after submitting.
 * See `types/review-feedback.ts` for why (Google prohibits review gating).
 */

interface Body {
  rating?: unknown;
  comment?: unknown;
  clickedGoogle?: unknown;
}

/** Mirrors the (unexported) Mode union in lib/server/tasks-service.ts. */
type Mode = "live" | "test";

/** Discriminated result of the feedback transaction. */
type TxnResult =
  | { ok: false; error: string; status: number }
  | {
      ok: true;
      agencyId: string;
      subAccountId: string;
      contactName: string;
      createdByUid: string;
      mode: Mode;
    };

/** Narrow an untrusted Firestore field to the Mode union. Anything that isn't
 *  an explicit "test" is treated as live — the safe default for a real
 *  customer's feedback. */
function modeFrom(raw: unknown): Mode {
  return raw === "test" ? "test" : "live";
}

export async function POST(request: Request) {
  const rate = checkCheckoutRateLimit(clientIpFrom(request));
  if (!rate.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again shortly." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } },
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const token = request.headers.get("x-review-token") ?? "";
  if (!token) {
    return NextResponse.json({ error: "Missing review token." }, { status: 400 });
  }

  const verified = verifyReviewToken(token);
  if (!verified) {
    return NextResponse.json({ error: "Invalid or expired link." }, { status: 404 });
  }

  // ── Validate the payload before touching Firestore ──────────────────────
  let rating: number | null = null;
  if (body.rating !== undefined && body.rating !== null) {
    const n = Number(body.rating);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      return NextResponse.json(
        { error: "rating must be an integer from 1 to 5." },
        { status: 400 },
      );
    }
    rating = n;
  }

  const comment =
    typeof body.comment === "string"
      ? body.comment.trim().slice(0, REVIEW_COMMENT_MAX)
      : "";
  const clickedGoogle = body.clickedGoogle === true;

  if (rating === null && !comment && !clickedGoogle) {
    return NextResponse.json({ error: "Nothing to record." }, { status: 400 });
  }

  /** A rating or a comment closes the link. A bare click-through ping does not. */
  const isSubmission = rating !== null || comment.length > 0;

  const db = getAdminDb();
  const contactRef = db.doc(`contacts/${verified.contactId}`);
  const feedbackRef = db.collection("reviewFeedback").doc();
  const ip = clientIpFrom(request);
  const userAgent = request.headers.get("user-agent")?.slice(0, 300) ?? null;

  // ── Atomic: verify the token, burn it, and write the feedback together ──
  // Doing these as separate steps would let two concurrent requests with the
  // same token both pass the hash check and both write.
  const result: TxnResult = await db.runTransaction<TxnResult>(async (tx) => {
    const snap = await tx.get(contactRef);
    if (!snap.exists) {
      return { ok: false, error: "Invalid or expired link.", status: 404 };
    }
    const contact = snap.data() as Record<string, unknown>;

    // The stored hash is the second half of the check — a validly signed token
    // for a contact whose link has since been re-issued or used must not work.
    if (contact.reviewTokenHash !== verified.hash) {
      return { ok: false, error: "Invalid or expired link.", status: 404 };
    }

    const agencyId = typeof contact.agencyId === "string" ? contact.agencyId : "";
    const subAccountId =
      typeof contact.subAccountId === "string" ? contact.subAccountId : "";
    if (!agencyId || !subAccountId) {
      return {
        ok: false,
        error: "Contact is missing tenancy metadata.",
        status: 500,
      };
    }

    tx.set(feedbackRef, {
      agencyId,
      subAccountId,
      contactId: verified.contactId,
      rating,
      comment,
      clickedGoogle,
      taskId: null,
      submittedFromIp: ip,
      submittedUserAgent: userAgent,
      // Abuse-triage only. The daily api-cleanup sweep nulls the IP + UA once
      // this passes, keeping the rating/comment forever (POPIA minimisation).
      piiExpiresAt: new Date(Date.now() + REVIEW_PII_RETENTION_DAYS * 86_400_000),
      createdAt: FieldValue.serverTimestamp(),
    });

    // Burn the token in the same commit, so a forwarded or replayed link
    // cannot be used again — including by a request already in flight.
    //
    // A click-through to Google is NOT a submission: the page fires that ping
    // when the customer opens the review link, and they can still come back
    // and leave private feedback afterwards. Burning on the ping would 404
    // that second request. Only a real rating/comment closes the link.
    if (isSubmission) {
      tx.update(contactRef, {
        reviewTokenHash: FieldValue.delete(),
        reviewFeedbackAt: FieldValue.serverTimestamp(),
      });
    } else {
      tx.update(contactRef, { reviewGoogleClickedAt: FieldValue.serverTimestamp() });
    }

    return {
      ok: true,
      agencyId,
      subAccountId,
      contactName:
        typeof contact.name === "string" && contact.name ? contact.name : "A customer",
      createdByUid:
        typeof contact.createdByUid === "string" ? contact.createdByUid : "system",
      mode: modeFrom(contact.mode),
    };
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  // ── Internal follow-up on an unhappy customer ───────────────────────────
  // Outside the transaction: the feedback is already durable, and losing the
  // task must not lose the customer's words. Changes nothing the customer sees.
  let taskId: string | null = null;
  const needsFollowUp =
    (rating !== null && rating <= REVIEW_FOLLOW_UP_THRESHOLD) ||
    (rating === null && comment.length > 0);

  if (needsFollowUp) {
    try {
      const created = await createTaskServerSide({
        subAccountId: result.subAccountId,
        agencyId: result.agencyId,
        createdByUid: result.createdByUid,
        mode: result.mode,
        title: rating
          ? `Follow up: ${result.contactName} left ${rating}★ feedback`
          : `Follow up: ${result.contactName} left feedback`,
        notes: comment || "(no comment left)",
        dueAt: new Date(),
        contactId: verified.contactId,
        dealId: null,
        eventId: null,
      });
      taskId = created.id;
      await feedbackRef.update({ taskId });
    } catch (err) {
      // Swallowed deliberately: the feedback row is already committed, and a
      // failed task write must not 500 a customer who did nothing wrong. The
      // row is still there for the owner to see.
      console.error("[reviews/feedback] follow-up task failed", err);
      taskId = null;
    }
  }

  return NextResponse.json({ ok: true, taskCreated: taskId !== null });
}
