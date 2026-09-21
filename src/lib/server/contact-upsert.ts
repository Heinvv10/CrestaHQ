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
  companyStringDrifts,
  fireTagsAdded,
} from "@/lib/server/contacts-service";
import type { CustomFieldValue } from "@/types/custom-fields";
import type { TriggerOutcome } from "@/lib/workflows/engine";

/**
 * Upsert a contact by phone — the phone is the identity, and a second call
 * with the same phone must never create a second contact.
 *
 * Firestore has no unique constraint, so a query-then-create would let two
 * concurrent calls both see "no such contact" and both create one — and a
 * query inside a transaction is not relied on to stop that (no phantom
 * protection is assumed). So every transaction also READS and then WRITES
 * one lock doc per phone (`subAccounts/{id}/contactPhoneIndex/{mode}_{e164}`).
 * Two racing transactions both read it, so the second to commit conflicts
 * and re-runs, and its re-run query finds the first one's contact.
 *
 * The lock write is a DELETE: a write is what creates the contention, and a
 * delete persists nothing, so no phone number outlives its contact in a
 * side collection and there is no stale pointer to reconcile. Do not
 * "optimise" the read or the delete away — together they ARE the race fix.
 *
 * The query runs on every call and is the only source of truth, so a
 * duplicate created later by another path (dashboard, form, import) is still
 * caught by the ambiguity refusal below.
 *
 * Matching is on the stored E.164 phone and mode. Contacts written by paths
 * that store the phone as typed — v1 form submissions, v1 PATCH, the bulk
 * importer — or with no `mode` (voice booking) will not match, and the first
 * upsert creates a second contact for that person.
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

export interface FiredTrigger {
  type: "contact.created" | "contact.tag.added";
  outcome: Promise<TriggerOutcome>;
}

export type UpsertOutcome =
  | {
      kind: "created" | "updated";
      id: string;
      contact: ContactApiObject;
      /** Workflow triggers this write fired, in firing order. */
      triggers: FiredTrigger[];
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
  const written = await db.runTransaction(async (tx) => {
    await tx.get(claimRef); // the lock — see the header
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
    const target = matches.docs[0] ?? null;
    tx.delete(claimRef);

    const tags = nextTags(target?.data()?.tags, input.tagsAdd, input.tagsRemove);
    const customFields = mergeCustomFields(target?.data()?.customFields, input.customFields);
    if (target) {
      const update = {
        ...input.fields,
        tags,
        customFields,
        // Same rule as updateContactServerSide: a company rename with no
        // companyId drops the link instead of leaving it stale.
        ...(companyStringDrifts(target.data() ?? {}, input.fields)
          ? { companyId: null }
          : {}),
      };
      tx.update(target.ref, { ...update, updatedAt: FieldValue.serverTimestamp() });
      return {
        kind: "updated" as const,
        id: target.id,
        beforeTags: target.data()?.tags,
        // What THIS transaction wrote — never a re-read, which could carry
        // another writer's tag and fire a trigger this request did not cause.
        after: { ...target.data(), ...update },
      };
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
    const triggers: FiredTrigger[] = [];
    if (trigger) triggers.push({ type: "contact.created", outcome: trigger });
    if (tagTrigger) triggers.push({ type: "contact.tag.added", outcome: tagTrigger });
    return { kind: "created", id: written.id, contact, triggers };
  }

  const contact = serializeContactForApi(
    written.id,
    { ...written.after, updatedAt: new Date() },
    input.mode,
  );
  void emitWebhookEvent({
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    mode: input.mode,
    type: "contact.updated",
    payload: { contact },
  });
  const tagTrigger = tagFire(written.beforeTags, written.after.tags);
  return {
    kind: "updated",
    id: written.id,
    contact,
    triggers: tagTrigger ? [{ type: "contact.tag.added", outcome: tagTrigger }] : [],
  };
}
