import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import type { QueryDocumentSnapshot } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { normalizePhoneLenient } from "@/lib/contacts/phone";
import { emitContactCreatedById } from "@/lib/server/contacts-service";
import { GLOBAL_TERRITORY_ID } from "@/types";
import type { Contact } from "@/types/contacts";

/**
 * Channel-agnostic identity-capture pipeline. Used by Web Chat (visitor
 * shares contact details in the floating widget) and Voice (caller
 * volunteers details over the phone) — same shape, same Contact
 * reconciliation, same marker parser.
 *
 * The LLM emits one of two markers at the end of its reply:
 *
 *   [[capture name="Jane Doe" email="jane@x.com" phone="+61400000000"]]
 *   [[form fields="name,email,phone"]]
 *
 * `parseCaptureMarker` / `parseFormMarker` strip the marker and return
 * the cleaned text. `reconcileContactFromCapture` finds an existing
 * Contact within the sub-account (by email OR phone depending on the
 * channel's preferred match strategy) or creates a new one.
 *
 * Session-linking is NOT done here — each channel owns its own session
 * artifact shape (webChatSessions row, voiceCalls row) so callers run
 * that linking step themselves after this returns.
 */

const MARKER_RE = /\[\[capture\s+([^\]]+)\]\]/i;
const FORM_MARKER_RE = /\[\[form\s+([^\]]+)\]\]/i;
const FIELD_RE = /(name|email|phone)="([^"]+)"/gi;
const FORM_FIELDS_RE = /fields="([^"]+)"/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9][\d\s\-().]{5,}$/;

export type CaptureFieldId = "name" | "email" | "phone";

export interface ParsedFormRequest {
  /** Visitor-visible reply with the [[form …]] marker stripped. */
  cleanText: string;
  /** Null when no form marker was present. */
  fields: CaptureFieldId[] | null;
}

/**
 * Parse the [[form fields="name,email,phone"]] marker the bot emits when
 * it wants to surface a structured inline form to the visitor. Field
 * order in the returned array preserves the bot's order so the widget
 * renders inputs in the requested sequence. Voice channels typically
 * don't render forms — they only use [[capture]] — but the parser is
 * harmless to call on voice transcripts (no marker = no fields).
 */
export function parseFormMarker(rawText: string): ParsedFormRequest {
  const match = FORM_MARKER_RE.exec(rawText);
  if (!match) return { cleanText: rawText, fields: null };

  const inner = match[1] ?? "";
  const fieldsMatch = FORM_FIELDS_RE.exec(inner);
  const fields: CaptureFieldId[] = [];
  if (fieldsMatch && fieldsMatch[1]) {
    const seen = new Set<string>();
    for (const raw of fieldsMatch[1].split(",")) {
      const f = raw.trim().toLowerCase();
      if ((f === "name" || f === "email" || f === "phone") && !seen.has(f)) {
        seen.add(f);
        fields.push(f);
      }
    }
  }

  const cleanText = rawText
    .replace(FORM_MARKER_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (fields.length === 0) {
    return { cleanText, fields: null };
  }

  return { cleanText, fields };
}

export interface ParsedCapture {
  /** Reply text with the marker line removed. Voice channels discard
   *  this (transcripts aren't replayed to the caller); web-chat shows
   *  it to the visitor. */
  cleanText: string;
  /** Null if no marker was present, otherwise the extracted fields.
   *  Fields the LLM didn't include come back as null. */
  capture: {
    name: string | null;
    email: string | null;
    phone: string | null;
  } | null;
}

export function parseCaptureMarker(rawText: string): ParsedCapture {
  const match = MARKER_RE.exec(rawText);
  if (!match) {
    return { cleanText: rawText, capture: null };
  }

  const inner = match[1] ?? "";
  let name: string | null = null;
  let email: string | null = null;
  let phone: string | null = null;

  for (const m of inner.matchAll(FIELD_RE)) {
    const key = m[1]?.toLowerCase();
    const value = m[2]?.trim();
    if (!value) continue;
    if (key === "name") name = value.slice(0, 200);
    else if (key === "email" && EMAIL_RE.test(value)) email = value;
    else if (key === "phone" && PHONE_RE.test(value)) phone = value;
  }

  const cleanText = rawText.replace(MARKER_RE, "").replace(/\n{3,}/g, "\n\n").trim();

  if (!name && !email && !phone) {
    return { cleanText, capture: null };
  }

  return { cleanText, capture: { name, email, phone } };
}

export interface ReconcileInput {
  agencyId: string;
  subAccountId: string;
  /** When non-null, skip reconciliation — caller already has a contact
   *  bound (e.g. inbound call from a known number resolved before the
   *  capture marker arrived). */
  existingContactId: string | null;
  /** Stored as attribution.landingPage on the new contact when present.
   *  Web Chat passes the visitor's page URL; voice passes null. */
  pageUrl: string | null;
  /** Stamped on the new Contact (e.g. "web-chat" | "voice"). Drives the
   *  source-badge pill in the contacts list. */
  source: string;
  /** Determines which identifier the resolver tries first. Web Chat
   *  uses "email-first" because emails on the web are typed
   *  deliberately; Voice uses "phone-first" because the caller's phone
   *  is always known from caller ID. The other identifier is tried as
   *  a fallback when the first one isn't present or doesn't match. */
  matchStrategy: "email-first" | "phone-first";
  capture: NonNullable<ParsedCapture["capture"]>;
}

export interface ReconcileResult {
  contactId: string;
  /** True when this call created a fresh Contact. False when an existing
   *  match was reused or the session was already linked. */
  created: boolean;
}

/**
 * Find an existing Contact within the sub-account, otherwise create a
 * new one. Safe to call multiple times — short-circuits when
 * existingContactId is set. Returns null when neither an email nor a
 * phone was extracted (nothing to match on, and creating a contact with
 * just a name risks storing hallucinations).
 *
 * On an existing match, best-effort backfills any BLANK name/email/phone
 * from what the visitor/caller just volunteered — mirroring the booking
 * reconciler (`src/lib/booking/contact-reconcile.ts`). Without this a name
 * or email offered mid-conversation was silently dropped whenever the
 * person already existed (matched by their other identifier). Curated data
 * on file is never overwritten.
 */
export async function reconcileContactFromCapture(
  input: ReconcileInput,
): Promise<ReconcileResult | null> {
  if (input.existingContactId) {
    return { contactId: input.existingContactId, created: false };
  }

  if (!input.capture.email && !input.capture.phone) return null;

  const db = getAdminDb();
  const contactsCol = db.collection("contacts");

  // Normalize the captured phone to E.164 (workspace defaultPhoneCountry
  // as the fallback for bare national numbers) so stored phones match the
  // E.164 `From` the Twilio inbound webhooks query with. Lenient: an
  // unparseable number keeps the as-typed string, never dropped. Matching
  // tries the normalized form FIRST, then the as-typed string, so legacy
  // contacts stored before normalization still match — strictly a superset
  // of the old exact-match behavior.
  const typedPhone = input.capture.phone;
  let phone = typedPhone;
  if (typedPhone) {
    const subSnap = await db.doc(`subAccounts/${input.subAccountId}`).get();
    phone = normalizePhoneLenient(
      typedPhone,
      (subSnap.data()?.defaultPhoneCountry as string | null) ?? null,
    );
  }

  const tryEmailMatch =
    async (): Promise<QueryDocumentSnapshot | null> => {
      if (!input.capture.email) return null;
      const snap = await contactsCol
        .where("subAccountId", "==", input.subAccountId)
        .where("email", "==", input.capture.email)
        .limit(1)
        .get();
      return snap.empty ? null : snap.docs[0];
    };

  const tryPhoneMatch =
    async (): Promise<QueryDocumentSnapshot | null> => {
      if (!phone) return null;
      const candidates =
        typedPhone && typedPhone !== phone ? [phone, typedPhone] : [phone];
      for (const candidate of candidates) {
        const snap = await contactsCol
          .where("subAccountId", "==", input.subAccountId)
          .where("phone", "==", candidate)
          .limit(1)
          .get();
        if (!snap.empty) return snap.docs[0];
      }
      return null;
    };

  const matchOrder =
    input.matchStrategy === "phone-first"
      ? [tryPhoneMatch, tryEmailMatch]
      : [tryEmailMatch, tryPhoneMatch];

  for (const lookup of matchOrder) {
    const hit = await lookup();
    if (hit) {
      await backfillContactFromCapture(hit, { ...input.capture, phone });
      return { contactId: hit.id, created: false };
    }
  }

  const contactRef = await contactsCol.add({
    name: input.capture.name ?? "",
    email: input.capture.email ?? "",
    phone: phone ?? "",
    company: "",
    address: "",
    source: input.source,
    tags: [],
    pipelineStage: null,
    attribution: input.pageUrl ? { landingPage: input.pageUrl } : null,
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    createdByUid: `${input.source}-bot`,
    emailOptedOut: false,
    smsOptedOut: false,
    countryCode: null,
    country: null,
    city: null,
    lat: null,
    lng: null,
    // Bot-captured leads (web-chat + voice) default to Global — visible
    // to every rep holding Global until an admin routes them. Harmless
    // when scoping is off.
    territoryId: GLOBAL_TERRITORY_ID,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  // A brand-new contact fires contact.created regardless of which channel
  // created it. The channel's own event (webchat.lead.captured /
  // voice.call.captured) still fires separately at the call site.
  void emitContactCreatedById({
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    contactId: contactRef.id,
  });

  return { contactId: contactRef.id, created: true };
}

/**
 * Fill blank name/email/phone on an already-existing contact from the
 * captured fields. Only touches fields that are currently empty — never
 * overwrites data already on file — and swallows write errors so a patch
 * blip can't break the capture flow (the Contact id is already resolved).
 */
async function backfillContactFromCapture(
  doc: QueryDocumentSnapshot,
  capture: NonNullable<ParsedCapture["capture"]>,
): Promise<void> {
  const data = doc.data() as Contact;
  const patch: Record<string, unknown> = {};
  if (capture.name && !data.name?.trim()) patch.name = capture.name;
  if (capture.email && !data.email?.trim()) patch.email = capture.email;
  if (capture.phone && !data.phone?.trim()) patch.phone = capture.phone;
  if (Object.keys(patch).length === 0) return;

  patch.updatedAt = FieldValue.serverTimestamp();
  try {
    await doc.ref.update(patch);
  } catch {
    // Non-fatal — the capture still succeeds with the fields it had.
  }
}
