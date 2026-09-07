import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { fireWorkflowTrigger } from "@/lib/workflows/engine";
import { normalizeDestinationUrl } from "./destination";
import { verifyTrackedLinkToken } from "./token";

/**
 * Resolve one visit to `/l/{token}`: record the click, fire `link.clicked`,
 * and hand back the destination for the 302. Returns null when the visit
 * must 404 — an unknown link, a forged token, or a destination that isn't
 * an http(s) URL. Never 302 on a null; that is the open-redirect case.
 *
 * Two shapes reach here:
 *   - a signed `linkId.contactId.sig` token → the click is attributed to
 *     the contact, the recipient's destination override wins, and the
 *     workflow trigger fires;
 *   - a bare `linkId` → the click is recorded with `contactId: null` and
 *     NOTHING fires. There is no contact to enrol.
 */

/** The id shape the token module signs — deliberately excludes ".", which
 *  is what stops a failed token from being re-read as a bare link id. */
const LINK_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

export async function resolveTrackedLinkClick(input: {
  token: string;
  userAgent: string | null;
  referer: string | null;
}): Promise<string | null> {
  const verified = verifyTrackedLinkToken(input.token);
  const linkId = verified?.linkId ?? input.token;
  if (!LINK_ID_RE.test(linkId)) return null;
  const contactId = verified?.contactId ?? null;

  const db = getAdminDb();
  const linkRef = db.doc(`trackedLinks/${linkId}`);
  const linkSnap = await linkRef.get();
  if (!linkSnap.exists) return null;
  const link = linkSnap.data() ?? {};

  const recipientRef = contactId
    ? linkRef.collection("recipients").doc(contactId)
    : null;
  const recipient = recipientRef
    ? ((await recipientRef.get()).data() ?? null)
    : null;

  // Re-validated on read, not just at write time — the redirect is the
  // thing an attacker would aim at, and a doc can predate the check.
  const destination = normalizeDestinationUrl(
    recipient?.destinationUrl ?? link.destinationUrl,
  );
  if (!destination) return null;

  const now = FieldValue.serverTimestamp();
  await linkRef.collection("clicks").add({
    contactId,
    clickedAt: now,
    userAgent: input.userAgent,
    referer: input.referer,
  });
  await linkRef.update({ clickCount: FieldValue.increment(1), lastClickedAt: now });
  // A signed token implies the recipient doc was minted, so this is only false
  // if it has since been deleted. The link-level click still counts.
  if (recipientRef && recipient) {
    await recipientRef.update({
      clickCount: FieldValue.increment(1),
      lastClickedAt: now,
      ...(recipient.firstClickedAt ? {} : { firstClickedAt: now }),
    });
  }

  // Awaited, not fire-and-forget: the response is a redirect and the
  // process may be torn down the moment it is written, so a detached
  // enrolment would be lost. Test-mode links never enrol — a sandbox
  // click must not message a real person.
  if (contactId && link.mode !== "test") {
    await fireWorkflowTrigger({
      agencyId: (link.agencyId as string) ?? "",
      subAccountId: (link.subAccountId as string) ?? "",
      type: "link.clicked",
      contactId,
      context: { linkId, linkName: (link.name as string) ?? "" },
    });
  }

  return destination;
}
