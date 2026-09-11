import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import { fireWorkflowTrigger, type TriggerOutcome } from "@/lib/workflows/engine";
import {
  serializeContactForApi,
  type ContactApiObject,
} from "@/lib/api/serializers/contacts";
import type { ContactAttribution } from "@/types/contacts";
import type { CustomFieldValue } from "@/types/custom-fields";
import { normalizePhoneLenient } from "@/lib/contacts/phone";
import { GLOBAL_TERRITORY_ID } from "@/types";

/**
 * Server-side Contact write service — the single chokepoint where a contact
 * is created/updated AND the matching webhook fires.
 *
 * Why this exists: the dashboard used to write contacts straight from the
 * browser via the client Firestore SDK, so no server code ran and no
 * `contact.created` webhook fired. Every dashboard write now POSTs to a
 * thin route that calls into here (Admin SDK), so a contact born in the UI
 * fires the same event as one created through `POST /api/v1/contacts`.
 *
 * Firing is free when nobody's listening: `emitWebhookEvent` early-returns
 * after one subscription lookup when no active subscription matches the
 * event type + mode, so these helpers are safe to call on every write.
 */

type Mode = "live" | "test";

/**
 * Fields a caller may set when creating a contact. Superset of the
 * dashboard `ContactFormData` and the public-API `ContactCreateInput`, so
 * both entry points share one write path. Everything past `tags` is
 * optional and defaults to the same values the old client/admin writes used.
 */
export interface CreateContactInput {
  subAccountId: string;
  agencyId: string;
  createdByUid: string;
  mode: Mode;
  name: string;
  email: string;
  phone: string;
  /**
   * Workspace `defaultPhoneCountry` for lenient E.164 normalization of
   * `phone` (see lib/contacts/phone.ts). Callers with the sub-account doc
   * in hand pass it through; absent → "US" fallback.
   */
  phoneCountry?: string | null;
  company: string;
  address: string;
  source: string;
  tags: string[];
  pipelineStage?: string | null;
  territoryId?: string | null;
  /** Member uid (validated by the route) or null. */
  assignedToUid?: string | null;
  /** Validated custom-field value map (routes validate against live defs). */
  customFields?: Record<string, CustomFieldValue> | null;
  attribution?: ContactAttribution | null;
  /**
   * Public-API key id, when the create came in over /api/v1/contacts.
   * Forwarded to the trigger so enrolments count against that key's hourly
   * cap (lib/api/enrolment-cap).
   */
  apiKeyId?: string;
  /** Optional resolved location (form submit supplies this; UI doesn't). */
  location?: {
    countryCode: string | null;
    country: string | null;
    city: string | null;
    lat: number | null;
    lng: number | null;
  } | null;
}

export interface ContactWriteResult {
  id: string;
  contact: ContactApiObject;
  /**
   * Whether this write fired a workflow trigger. The tag diff that decides
   * it lives here and only here, so a caller holding an enrolment
   * reservation (the public API) can settle it without re-deriving the diff
   * — see lib/api/enrolment-cap.
   */
  firedTrigger: boolean;
}

/**
 * Create a contact + emit `contact.created`. Returns the new id and the
 * serialized wire object (handy for the API response). The webhook is
 * fire-and-forget — the write never blocks on dispatch.
 */
export async function createContactServerSide(
  input: CreateContactInput
): Promise<ContactWriteResult> {
  const ref = getAdminDb().collection("contacts").doc();
  const doc = buildContactDoc(input);
  await ref.set(doc);
  const { contact, trigger } = announceContactCreated(input, ref.id, doc);
  return { id: ref.id, contact, firedTrigger: trigger !== null };
}

/**
 * The document a new contact is written as. Shared with the phone upsert
 * (lib/server/contact-upsert), which writes it inside a transaction, so a
 * contact created either way has the same shape.
 */
export function buildContactDoc(input: CreateContactInput) {
  const loc = input.location ?? null;
  return {
    name: input.name,
    email: input.email,
    phone: normalizePhoneLenient(input.phone, input.phoneCountry),
    company: input.company,
    address: input.address,
    source: input.source,
    tags: [...new Set(input.tags)],
    pipelineStage: input.pipelineStage ?? null,
    customFields: input.customFields ?? {},
    attribution: input.attribution ?? null,
    emailOptedOut: false,
    smsOptedOut: false,
    countryCode: loc?.countryCode ?? null,
    country: loc?.country ?? null,
    city: loc?.city ?? null,
    lat: loc?.lat ?? null,
    lng: loc?.lng ?? null,
    territoryId: input.territoryId ?? GLOBAL_TERRITORY_ID,
    assignedToUid: input.assignedToUid ?? null,
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    createdByUid: input.createdByUid,
    mode: input.mode,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

type Announcer = Pick<CreateContactInput, "subAccountId" | "agencyId" | "mode" | "apiKeyId">;

/**
 * Everything a newly written contact announces: the `contact.created`
 * webhook and, in live mode, the workflow trigger. Returns the trigger's
 * promise (null when none fired) so a caller that must know the outcome can
 * await it; every other caller discards it.
 */
export function announceContactCreated(
  input: Announcer,
  id: string,
  doc: ReturnType<typeof buildContactDoc>,
): { contact: ContactApiObject; trigger: Promise<TriggerOutcome> | null } {
  // Serialize from the in-memory doc with a JS `now` for the timestamps
  // (the serverTimestamp sentinels aren't readable without a re-read, and a
  // sub-millisecond drift on created_at is immaterial to subscribers).
  const now = new Date();
  const contact = serializeContactForApi(
    id,
    { ...doc, createdAt: now, updatedAt: now },
    input.mode
  );

  void emitWebhookEvent({
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    mode: input.mode,
    type: "contact.created",
    payload: { contact },
  });
  const trigger =
    input.mode === "live"
      ? fireWorkflowTrigger({
          subAccountId: input.subAccountId,
          agencyId: input.agencyId,
          type: "contact.created",
          contactId: id,
          apiKeyId: input.apiKeyId,
        })
      : null;
  return { contact, trigger };
}

/** Fields that can be patched. All optional; only provided keys are written. */
export interface UpdateContactPatch {
  name?: string;
  email?: string;
  phone?: string;
  company?: string;
  address?: string;
  source?: string;
  tags?: string[];
  pipelineStage?: string | null;
  /**
   * Straight field write, same as the public API has always done. A full
   * territory MOVE (fanning out to the contact's deals/quotes/tasks/events)
   * still belongs to the dedicated admin endpoint — see the note below.
   */
  territoryId?: string | null;
  /** Member uid (validated by the route) or null to unassign. */
  assignedToUid?: string | null;
  /** Full replacement of the custom-field value map (validated by the route). */
  customFields?: Record<string, CustomFieldValue>;
}

/**
 * Update a contact + emit `contact.updated`. Reads the doc back so the
 * webhook payload + return value reflect the merged state. Returns null when
 * the contact doesn't exist.
 *
 * Territory patches atomically update conversation access alongside the contact.
 * The dashboard endpoint also cascades to deals/quotes/tasks/events.
 */
export async function updateContactServerSide(opts: {
  contactId: string;
  patch: UpdateContactPatch;
  /** The contact's mode (from the existing doc); defaults to live. */
  mode?: Mode;
  /**
   * Public-API key id, when the update came in over /api/v1/contacts.
   * Forwarded to the trigger so enrolments count against that key's hourly
   * cap (lib/api/enrolment-cap).
   */
  apiKeyId?: string;
}): Promise<ContactWriteResult | null> {
  const db = getAdminDb();
  const ref = db.doc(`contacts/${opts.contactId}`);
  const snap = await ref.get();
  if (!snap.exists) return null;

  const existing = snap.data()!;
  const mode = opts.mode ?? (existing.mode as Mode) ?? "live";
  const patch = {
    ...opts.patch,
    ...(opts.patch.tags ? { tags: [...new Set(opts.patch.tags)] } : {}),
  };

  // update(), not set(..., {merge: true}): merge recurses into nested maps,
  // which would keep cleared customFields values forever. update() replaces
  // a map field wholesale and behaves identically for the scalar fields.
  const update = { ...patch, updatedAt: FieldValue.serverTimestamp() };
  if (Object.prototype.hasOwnProperty.call(patch, "territoryId")) {
    await db.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data();
      if (
        !current ||
        current.subAccountId !== existing.subAccountId ||
        current.agencyId !== existing.agencyId
      )
        throw new Error("Contact tenant changed during territory update.");
      const conversations = await tx.get(
        db
          .collection("conversations")
          .where("subAccountId", "==", current.subAccountId)
          .where("contactId", "==", opts.contactId)
      );
      for (const conversation of conversations.docs)
        if (conversation.data().agencyId !== current.agencyId)
          throw new Error(
            "Conversation tenant mismatch during territory update."
          );
      tx.update(ref, update);
      for (const conversation of conversations.docs)
        tx.update(conversation.ref, {
          territoryId: patch.territoryId ?? null,
          updatedAt: update.updatedAt,
        });
    });
  } else {
    await ref.update(update);
  }

  const fresh = await ref.get();
  const contact = serializeContactForApi(fresh.id, fresh.data()!, mode);

  void emitWebhookEvent({
    subAccountId: existing.subAccountId,
    agencyId: existing.agencyId,
    mode,
    type: "contact.updated",
    payload: { contact },
  });
  // Replace-semantics patch → diff against the pre-update tags.
  const trigger = patch.tags
    ? fireTagsAdded({
        subAccountId: existing.subAccountId,
        agencyId: existing.agencyId,
        contactId: opts.contactId,
        mode,
        before: existing.tags,
        after: patch.tags,
        apiKeyId: opts.apiKeyId,
      })
    : null;

  return { id: ref.id, contact, firedTrigger: trigger !== null };
}

/**
 * THE tag diff — the only place that decides whether a write added a tag.
 * Fires `contact.tag.added` once, with only the tags `after` introduces over
 * `before`, and only in live mode. Returns the trigger's promise, or null
 * when nothing fired. Used by the update path above and the phone upsert.
 */
export function fireTagsAdded(opts: {
  subAccountId: string;
  agencyId: string;
  contactId: string;
  mode: Mode;
  /** Tags before the write — anything non-array reads as none. */
  before: unknown;
  after: string[];
  apiKeyId?: string;
}): Promise<TriggerOutcome> | null {
  if (opts.mode !== "live") return null;
  const oldTags: string[] = Array.isArray(opts.before) ? opts.before : [];
  const added = opts.after.filter((t) => !oldTags.includes(t));
  if (added.length === 0) return null;
  return fireWorkflowTrigger({
    subAccountId: opts.subAccountId,
    agencyId: opts.agencyId,
    type: "contact.tag.added",
    contactId: opts.contactId,
    context: { addedTags: added },
    apiKeyId: opts.apiKeyId,
  });
}

/**
 * Emit `contact.created` for a contact that was ALREADY written elsewhere
 * (public form submit, web-chat / voice capture, booking reconcile). Reads
 * the doc, serializes it, fires the event. Self-guarded so it's safe to
 * `void` from any write path — a read blip can never break the originating
 * request.
 */
export async function emitContactCreatedById(opts: {
  subAccountId: string;
  agencyId: string;
  contactId: string;
  mode?: Mode;
}): Promise<void> {
  try {
    const snap = await getAdminDb().doc(`contacts/${opts.contactId}`).get();
    if (!snap.exists) return;
    const mode = opts.mode ?? (snap.data()!.mode as Mode) ?? "live";
    const contact = serializeContactForApi(snap.id, snap.data()!, mode);
    await emitWebhookEvent({
      subAccountId: opts.subAccountId,
      agencyId: opts.agencyId,
      mode,
      type: "contact.created",
      payload: { contact },
    });
    if (mode === "live") {
      void fireWorkflowTrigger({
        subAccountId: opts.subAccountId,
        agencyId: opts.agencyId,
        type: "contact.created",
        contactId: opts.contactId,
      });
    }
  } catch (err) {
    console.warn("[contacts-service] emitContactCreatedById failed", err);
  }
}

/**
 * Emit `contact.deleted`. Called from the contact DELETE route, which has
 * already read the doc (the contact is gone by the time subscribers react,
 * so we serialize from the pre-delete snapshot data).
 */
export function emitContactDeleted(opts: {
  subAccountId: string;
  agencyId: string;
  contactId: string;
  data: FirebaseFirestore.DocumentData;
  mode?: Mode;
}): void {
  const mode = opts.mode ?? (opts.data.mode as Mode) ?? "live";
  const contact = serializeContactForApi(opts.contactId, opts.data, mode);
  void emitWebhookEvent({
    subAccountId: opts.subAccountId,
    agencyId: opts.agencyId,
    mode,
    type: "contact.deleted",
    payload: { contact },
  });
}
