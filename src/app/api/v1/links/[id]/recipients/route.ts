import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { withApiAuth } from "@/lib/api/auth";
import { apiError, apiOk } from "@/lib/api/responses";
import { parseLinkRecipientCreate } from "@/lib/api/serializers/links";
import {
  buildTrackedLinkUrl,
  issueTrackedLinkToken,
} from "@/lib/tracked-links/token";

/**
 * Public API v1: mint a per-contact click URL for a tracked link.
 *
 *   POST /api/v1/links/:id/recipients
 *   Body: { contact_id: string, destination_url?: string }
 *
 * Returns the absolute `/l/{token}` URL to put in the outbound message.
 * The token is a deterministic HMAC over (link, contact), so re-minting is
 * idempotent and returns the same URL.
 *
 * Both the link and the contact must belong to the key's sub-account AND
 * its mode — a test key can never mint a live link's URL.
 */
export const POST = withApiAuth<{ id: string }>(
  async ({ body, params, ctx }) => {
    const parsed = parseLinkRecipientCreate(body);
    if (!parsed.ok) {
      return apiError(ctx, "invalid_request", "invalid_body", parsed.error!);
    }
    const input = parsed.value!;

    const db = getAdminDb();
    const linkRef = db.doc(`trackedLinks/${params.id}`);
    const linkSnap = await linkRef.get();
    const link = linkSnap.data();
    if (
      !linkSnap.exists ||
      link!.subAccountId !== ctx.subAccountId ||
      link!.mode !== ctx.mode
    ) {
      return apiError(
        ctx,
        "invalid_request",
        "link_not_found",
        `No link with id ${params.id}.`,
      );
    }

    const contactSnap = await db.doc(`contacts/${input.contactId}`).get();
    const contact = contactSnap.data();
    if (
      !contactSnap.exists ||
      contact!.subAccountId !== ctx.subAccountId ||
      contact!.mode !== ctx.mode
    ) {
      return apiError(
        ctx,
        "invalid_request",
        "contact_not_found",
        `No contact with id ${input.contactId}.`,
      );
    }

    const recipientRef = linkRef.collection("recipients").doc(input.contactId);
    const existing = await recipientRef.get();
    await recipientRef.set(
      existing.exists
        ? { destinationUrl: input.destinationUrl }
        : {
            destinationUrl: input.destinationUrl,
            clickCount: 0,
            firstClickedAt: null,
            lastClickedAt: null,
            createdAt: FieldValue.serverTimestamp(),
          },
      { merge: true },
    );

    const token = issueTrackedLinkToken(params.id, input.contactId);
    return apiOk(
      ctx,
      {
        recipient: {
          object: "link_recipient",
          link_id: params.id,
          contact_id: input.contactId,
          destination_url: input.destinationUrl,
          url: buildTrackedLinkUrl(token),
        },
      },
      { status: 201 },
    );
  },
);
