import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import {
  serializeContactForApi,
  type ContactApiObject,
} from "@/lib/api/serializers/contacts";
import {
  announceContactCreated,
  buildContactDoc,
  fireTagsAdded,
} from "@/lib/server/contacts-service";
import type { CustomFieldValue } from "@/types/custom-fields";

/**
 * Upsert a contact by phone — the phone is the identity, and a second call
 * with the same phone must never create a second contact.
 *
 * Firestore has no unique constraint, so a query-then-create would let two
 * concurrent calls both see "no such contact" and both create one. The
 * find-or-create therefore runs in ONE transaction that reads a claim doc
 * keyed by the phone (`subAccounts/{id}/contactPhoneIndex/{mode}_{e164}`)
 * and writes the contact and the claim together. Two racing transactions
 * contend on the claim doc, so the loser retries and finds the winner's
 * contact.
 *
 * The claim is a lock and a cache, never trusted on its own: it is re-verified
 * against the contact it names (same tenant, same mode, same phone), and a
 * stale one — contact deleted, or its phone since edited — falls through to a
 * query. Contacts created elsewhere (dashboard, forms, imports) have no
 * claim; the query finds them, and the first upsert writes one.
 *
 * Matching is on the stored E.164 phone. A contact whose phone was stored
 * un-normalised (some legacy imports) will not match, and gets a new contact.
 *
 * More than one existing contact on the phone is refused, never guessed at:
 * writing install details onto the wrong household member is worse than a
 * refusal a human can resolve.
 *
 * Tags are added and removed against the contact's CURRENT tags inside the
 * transaction — never a whole-array replace, so a tag an operator applied a
 * moment ago survives. Custom fields merge per key (null clears one).
 */

type Mode = "live" | "test";

export interface UpsertContactInput {
  subAccountId: string;
  agencyId: string;
  mode: Mode;
  createdByUid: string;
  apiKeyId?: string;
  /** Already normalised to E.164 by the caller. */
  phone: string;
  /** Only the keys provided are written. */
  fields: Partial<Record<"name" | "email" | "company" | "address" | "source", string>>;
  /** Validated against the live definitions; null clears a key. */
  customFields: Record<string, CustomFieldValue | null>;
  /** Required contact fields — enforced only when a contact is created. */
  requiredCustomFields: Array<{ key: string; label: string }>;
  tagsAdd: string[];
  tagsRemove: string[];
}

export type UpsertOutcome =
  | {
      kind: "created" | "updated";
      id: string;
      contact: ContactApiObject;
      /** Workflow triggers this write fired, in firing order. */
      triggers: Promise<void>[];
    }
  | { kind: "ambiguous"; contactIds: string[] }
  | { kind: "refused"; error: string };

const blank = (v: unknown) =>
  v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

function nextTags(current: unknown, add: string[], remove: string[]): string[] {
  const base = Array.isArray(current) ? (current as string[]) : [];
  return [...new Set([...base, ...add])].filter((t) => !remove.includes(t));
}

function mergeCustomFields(
  current: unknown,
  patch: Record<string, CustomFieldValue | null>,
): Record<string, CustomFieldValue> {
  const out = { ...((current as Record<string, CustomFieldValue>) ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (blank(v)) delete out[k];
    else out[k] = v as CustomFieldValue;
  }
  return out;
}

export async function upsertContactByPhone(
  input: UpsertContactInput,
): Promise<UpsertOutcome> {
  const db = getAdminDb();
  const claimRef = db.doc(
    `subAccounts/${input.subAccountId}/contactPhoneIndex/${input.mode}_${input.phone}`,
  );
  const owns = (d: FirebaseFirestore.DocumentData | undefined) =>
    !!d &&
    d.subAccountId === input.subAccountId &&
    d.mode === input.mode &&
    d.phone === input.phone;

  const written = await db.runTransaction(async (tx) => {
    const claim = await tx.get(claimRef);
    let target: FirebaseFirestore.DocumentSnapshot | null = null;
    const claimedId = claim.data()?.contactId as string | undefined;
    if (claimedId) {
      const snap = await tx.get(db.doc(`contacts/${claimedId}`));
      if (snap.exists && owns(snap.data())) target = snap;
    }
    if (!target) {
      const matches = await tx.get(
        db
          .collection("contacts")
          .where("subAccountId", "==", input.subAccountId)
          .where("mode", "==", input.mode)
          .where("phone", "==", input.phone)
          .limit(10),
      );
      if (matches.size > 1) {
        return { kind: "ambiguous" as const, contactIds: matches.docs.map((d) => d.id) };
      }
      target = matches.docs[0] ?? null;
    }

    const tags = nextTags(target?.data()?.tags, input.tagsAdd, input.tagsRemove);
    const customFields = mergeCustomFields(target?.data()?.customFields, input.customFields);
    const claimDoc = {
      contactId: "",
      subAccountId: input.subAccountId,
      mode: input.mode,
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (target) {
      tx.update(target.ref, {
        ...input.fields,
        tags,
        customFields,
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (claimedId !== target.id) tx.set(claimRef, { ...claimDoc, contactId: target.id });
      return { kind: "updated" as const, id: target.id, beforeTags: target.data()?.tags };
    }

    const name = input.fields.name ?? "";
    if (!name) return { kind: "refused" as const, error: "`name` is required to create a contact." };
    const missing = input.requiredCustomFields.find((f) => blank(customFields[f.key]));
    if (missing) return { kind: "refused" as const, error: `"${missing.label}" is required.` };

    const ref = db.collection("contacts").doc();
    const doc = buildContactDoc({
      subAccountId: input.subAccountId,
      agencyId: input.agencyId,
      createdByUid: input.createdByUid,
      mode: input.mode,
      name,
      email: input.fields.email ?? "",
      phone: input.phone,
      company: input.fields.company ?? "",
      address: input.fields.address ?? "",
      source: input.fields.source ?? "",
      tags,
      customFields,
    });
    tx.set(ref, doc);
    tx.set(claimRef, { ...claimDoc, contactId: ref.id });
    return { kind: "created" as const, id: ref.id, doc };
  });

  if (written.kind === "ambiguous" || written.kind === "refused") return written;

  // Announce only after the commit: a transaction retried on contention
  // runs its body twice, and a webhook or enrolment must fire once.
  const tagFire = (before: unknown, after: string[]) =>
    fireTagsAdded({
      subAccountId: input.subAccountId,
      agencyId: input.agencyId,
      contactId: written.id,
      mode: input.mode,
      before,
      after,
      apiKeyId: input.apiKeyId,
    });

  if (written.kind === "created") {
    const { contact, trigger } = announceContactCreated(input, written.id, written.doc);
    const tagTrigger = tagFire([], written.doc.tags);
    return {
      kind: "created",
      id: written.id,
      contact,
      triggers: [trigger, tagTrigger].filter((t): t is Promise<void> => t !== null),
    };
  }

  const fresh = await db.doc(`contacts/${written.id}`).get();
  const contact = serializeContactForApi(written.id, fresh.data()!, input.mode);
  void emitWebhookEvent({
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    mode: input.mode,
    type: "contact.updated",
    payload: { contact },
  });
  const tagTrigger = tagFire(written.beforeTags, contact.tags);
  return {
    kind: "updated",
    id: written.id,
    contact,
    triggers: tagTrigger ? [tagTrigger] : [],
  };
}
