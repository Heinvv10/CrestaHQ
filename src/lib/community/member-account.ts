import "server-only";

import { createHash } from "node:crypto";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { createContactServerSide } from "@/lib/server/contacts-service";
import type { Member } from "@/types/community";

/**
 * Look up a member identity by email within a sub-account. Email is the natural
 * key (one identity per email per sub-account); we query rather than use a
 * deterministic doc id so an email change wouldn't orphan the doc.
 */
export async function findMemberByEmail(
  subAccountId: string,
  email: string,
): Promise<Member | null> {
  const snap = await getAdminDb()
    .collection(`subAccounts/${subAccountId}/members`)
    .where("email", "==", email.trim().toLowerCase())
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...(doc.data() as Omit<Member, "id">) };
}

/** Deterministic id for a member created by `ensureMember`; see the claim below. */
function memberDocId(subAccountId: string, normalizedEmail: string): string {
  return createHash("sha256").update(`member:${subAccountId}:${normalizedEmail}`).digest("hex").slice(0, 40);
}

interface EnsureMemberInput {
  subAccountId: string;
  email: string;
  displayName?: string | null;
}

/**
 * Idempotently get-or-create a member identity for `email` in this sub-account,
 * reconciling it to a CRM contact along the way (joining the community doubles
 * as lead capture). Called at magic-link VERIFY time — never at request time —
 * so a login request alone never creates a member doc. The one other caller is
 * the paid product-order delivery (`entitlements-service`), which creates a
 * member from the email the BUYER typed at checkout, unverified: whoever pays
 * can make a member for any address. That only grants what the payment bought;
 * signing in still needs a magic link sent to that address.
 *
 * Contact reconciliation: reuse an existing contact matched by email within the
 * sub-account, otherwise create one (`source: "community"`) via the same
 * server-side write path the rest of the app uses, so `contact.created` fires.
 *
 * Concurrent calls for the same brand-new email create one member (see the
 * deterministic-id claim in the body); the loser returns the winner's doc.
 */
export async function ensureMember({
  subAccountId,
  email,
  displayName,
}: EnsureMemberInput): Promise<Member> {
  const db = getAdminDb();
  const normalizedEmail = email.trim().toLowerCase();

  const existing = await findMemberByEmail(subAccountId, normalizedEmail);
  if (existing) return existing;

  // Resolve tenancy + the audit actor for the reconciled contact.
  const saSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!saSnap.exists) {
    throw new Error(`Sub-account ${subAccountId} not found`);
  }
  const sa = saSnap.data()!;
  const agencyId = (sa.agencyId as string) ?? "";
  const ownerUid = (sa.createdByUid as string) ?? "";

  // Claim the member first, under an id derived from (sub-account, email), so
  // two concurrent first sightings of one email (two orders, a verify racing a
  // purchase) create ONE member: the loser's create() fails and it reads the
  // winner. Members created before this carry random ids and are found by the
  // email query above. Only the winner reconciles the contact, so the race
  // can't create two contacts either.
  const ref = db.doc(`subAccounts/${subAccountId}/members/${memberDocId(subAccountId, normalizedEmail)}`);
  try {
    await ref.create({
      subAccountId,
      agencyId,
      email: normalizedEmail,
      displayName: displayName?.trim() || null,
      avatarUrl: null,
      bio: "",
      contactId: null,
      status: "active",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      lastSeenAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    if ((err as { code?: unknown }).code !== 6) throw err;
    const winner = await ref.get();
    return { id: ref.id, ...(winner.data() as Omit<Member, "id">) };
  }

  // Reconcile to an existing contact by email, else create one.
  let contactId: string | null = null;
  try {
    const contactSnap = await db
      .collection("contacts")
      .where("subAccountId", "==", subAccountId)
      .where("email", "==", normalizedEmail)
      .limit(1)
      .get();
    if (!contactSnap.empty) {
      contactId = contactSnap.docs[0].id;
    } else {
      const result = await createContactServerSide({
        subAccountId,
        agencyId,
        createdByUid: ownerUid,
        mode: "live",
        name: displayName?.trim() || "",
        email: normalizedEmail,
        phone: "",
        company: "",
        address: "",
        source: "community",
        tags: [],
      });
      contactId = result.id;
    }
    await ref.update({ contactId, updatedAt: FieldValue.serverTimestamp() });
  } catch (err) {
    // A reconciliation blip must not block the member from signing in — the
    // contact link is recoverable, the login is not.
    console.warn("[community/member-account] contact reconcile failed", err);
  }

  const snap = await ref.get();
  return { id: ref.id, ...(snap.data() as Omit<Member, "id">) };
}
