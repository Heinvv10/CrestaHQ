import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { verifyReviewToken } from "@/lib/reviews/feedback-token";
import { createTaskServerSide } from "@/lib/server/tasks-service";
import {
  REVIEW_COMMENT_MAX,
  REVIEW_FOLLOW_UP_THRESHOLD,
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
 * COMPLIANCE: this endpoint never decides whether the customer sees the Google
 * review link — the page shows it to everyone, before and after submitting.
 * See `types/review-feedback.ts` for why (Google prohibits review gating).
 */

interface Body {
  rating?: unknown;
  comment?: unknown;
  clickedGoogle?: unknown;
}

function clientIp(request: Request): string | null {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim().slice(0, 64) || null;
  return request.headers.get("x-real-ip")?.slice(0, 64) ?? null;
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ token?: string }> },
) {
  void ctx;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const token = typeof body === "object" && body !== null
    ? (request.headers.get("x-review-token") ?? "")
    : "";
  if (!token) {
    return NextResponse.json({ error: "Missing review token." }, { status: 400 });
  }

  const verified = verifyReviewToken(token);
  if (!verified) {
    return NextResponse.json({ error: "Invalid or expired link." }, { status: 404 });
  }

  const db = getAdminDb();
  const contactRef = db.doc(`contacts/${verified.contactId}`);
  const snap = await contactRef.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Invalid or expired link." }, { status: 404 });
  }
  const contact = snap.data() as Record<string, unknown>;

  // The hash on the contact is the second half of the check — a validly signed
  // token for a contact whose link has since been re-issued must not work.
  if (contact.reviewTokenHash !== verified.hash) {
    return NextResponse.json({ error: "Invalid or expired link." }, { status: 404 });
  }

  const agencyId = typeof contact.agencyId === "string" ? contact.agencyId : "";
  const subAccountId =
    typeof contact.subAccountId === "string" ? contact.subAccountId : "";
  if (!agencyId || !subAccountId) {
    return NextResponse.json(
      { error: "Contact is missing tenancy metadata." },
      { status: 500 },
    );
  }

  // ── Validate the payload ────────────────────────────────────────────────
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
    return NextResponse.json(
      { error: "Nothing to record." },
      { status: 400 },
    );
  }

  const feedbackRef = db.collection("reviewFeedback").doc();
  await feedbackRef.set({
    agencyId,
    subAccountId,
    contactId: verified.contactId,
    rating,
    comment,
    clickedGoogle,
    taskId: null,
    submittedFromIp: clientIp(request),
    submittedUserAgent: request.headers.get("user-agent")?.slice(0, 300) ?? null,
    createdAt: FieldValue.serverTimestamp(),
  });

  // ── Internal follow-up on an unhappy customer ───────────────────────────
  // This is the point of capturing a rating at all: the owner hears about it
  // now instead of reading it on Google next week. It changes nothing the
  // customer sees.
  let taskId: string | null = null;
  const needsFollowUp =
    (rating !== null && rating <= REVIEW_FOLLOW_UP_THRESHOLD) ||
    (rating === null && comment.length > 0);

  if (needsFollowUp) {
    const contactName =
      typeof contact.name === "string" && contact.name ? contact.name : "A customer";
    try {
      const created = await createTaskServerSide({
        subAccountId,
        agencyId,
        createdByUid:
          typeof contact.createdByUid === "string" ? contact.createdByUid : "system",
        mode: (contact.mode as never) ?? ("live" as never),
        title: rating
          ? `Follow up: ${contactName} left ${rating}★ feedback`
          : `Follow up: ${contactName} left feedback`,
        notes: comment || "(no comment left)",
        dueAt: new Date(),
        contactId: verified.contactId,
        dealId: null,
        eventId: null,
      });
      taskId = created.id;
      await feedbackRef.update({ taskId });
    } catch {
      // A failed task write must not lose the customer's feedback — the
      // feedback doc is already committed above. Surface nothing to the
      // customer; the row is still there for the owner to see.
      taskId = null;
    }
  }

  // Burn the token so a forwarded link can't be replayed. A re-send issues a
  // fresh one.
  await contactRef.update({
    reviewTokenHash: FieldValue.delete(),
    reviewFeedbackAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ ok: true, taskCreated: taskId !== null });
}
