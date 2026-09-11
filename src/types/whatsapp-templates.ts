import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * WhatsApp message templates (v2). Meta-pre-approved messages — the only
 * compliant way to start or re-open a WhatsApp conversation outside the
 * 24-hour session window. Delivered via Twilio's Content API (Twilio is the
 * BSP), so submission is API-driven but the approval decision is Meta's.
 *
 * Stored per-sub-account at `subAccounts/{id}/whatsappTemplates/{id}`. Kept
 * separate from `message_templates` (email/SMS) because the lifecycle is
 * different — these carry an external approval state machine + a Twilio
 * `contentSid`, and their variables are positional ({{1}}, {{2}}) per Meta's
 * format rather than named merge tags.
 */

/** Meta template category. Drives pricing + review strictness. v1 gallery
 *  uses UTILITY + MARKETING; AUTHENTICATION (OTP) isn't relevant to this
 *  product but is allowed by the type for completeness. */
export type WhatsappTemplateCategory =
  | "UTILITY"
  | "MARKETING"
  | "AUTHENTICATION";

/**
 * Lifecycle. `draft` is local-only; `submitting` covers the brief window
 * while the Twilio Content + approval request is being created; `pending`
 * is awaiting Meta's decision (Twilio "received"/"pending" both map here);
 * `approved` is sendable; `rejected` carries a reason; `paused`/`disabled`
 * are post-approval states Meta can apply; `failed` means the submission to
 * Twilio itself errored (network/validation) — distinct from a Meta rejection.
 */
export type WhatsappTemplateStatus =
  | "draft"
  | "submitting"
  | "pending"
  | "approved"
  | "rejected"
  | "paused"
  | "disabled"
  | "failed";

/** Where a positional variable's value comes from at send time. */
export type WhatsappVariableSource = "merge_tag" | "manual";

/**
 * One positional variable ({{1}}, {{2}}, …) in the template body.
 *  - `merge_tag`: auto-resolved from the contact at send time (the mapped
 *     merge tag, e.g. "contact.firstName"). Pre-filled in the composer and
 *     the only kind usable by future automations/broadcasts (no human in
 *     the loop).
 *  - `manual`: the operator types the value when sending (e.g. a quote link
 *     or appointment time that has no merge tag yet). v1 foundation supports
 *     these via the manual composer only.
 * `sampleValue` is required — Meta needs a realistic example for review.
 */
export interface WhatsappTemplateVariable {
  /** 1-indexed position matching the {{n}} in `body`. */
  position: number;
  /** Human label shown in the builder + composer (e.g. "First name"). */
  label: string;
  /** Example value submitted to Meta for approval review. */
  sampleValue: string;
  source: WhatsappVariableSource;
  /** Mapped merge tag (e.g. "contact.firstName") when source is merge_tag;
   *  null for manual. Validated against the merge-tag allow-list. */
  mergeTag: string | null;
}

export type WhatsappTemplateButton =
  | { type: "quick_reply"; text: string }
  | { type: "url"; text: string; url: string };

export interface WhatsappTemplateDoc {
  id: string;
  subAccountId: string;
  agencyId: string;
  /** Meta template name: lowercase + underscores, unique per WABA. Generated
   *  from displayName at submit if not set. */
  name: string;
  /** Friendly label shown in the UI. */
  displayName: string;
  category: WhatsappTemplateCategory;
  /** BCP-47-ish language code, e.g. "en", "en_US". */
  language: string;
  /** Body with positional {{1}}-style placeholders. */
  body: string;
  variables: WhatsappTemplateVariable[];
  /** Up to 3 buttons — quick replies first, then URLs. Absent on every
   *  template that predates buttons. A quick-reply tap comes back as a reply
   *  whose text is the button's text (see cloud-payload.ts). */
  buttons?: WhatsappTemplateButton[];
  /** The unapproved Twilio Content resource its buttons go with in-session,
   *  keyed by a fingerprint of what Twilio holds — see
   *  lib/comms/whatsapp/twilio-session-content.ts. */
  twilioSessionContent?: {
    sid: string;
    fingerprint: string;
    createdAt?: Timestamp | FieldValue | null;
  } | null;
  /** Twilio Content resource id (HX…). Null until submitted. The send path
   *  references this; the approval-poll keys off it.
   *
   *  These flat fields ARE the `twilio` registration — see
   *  `lib/comms/whatsapp/template-registrations.ts`. Approval belongs to a
   *  WABA, so other rails carry their own state in `registrations` instead of
   *  sharing these. */
  contentSid: string | null;
  status: WhatsappTemplateStatus;
  /** Populated when status is "rejected" (Meta's reason) or "failed" (the
   *  Twilio submission error). */
  rejectionReason: string | null;
  /** QStash approval-poll bookkeeping — mirrors the website-builder poll. */
  pollAttempts: number;
  lastSyncedAt: Timestamp | FieldValue | null;
  createdByUid: string;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
  approvedAt: Timestamp | FieldValue | null;
  /** Per-provider approval state for rails other than Twilio. Absent on every
   *  template predating the provider seam, which is why the reader falls back
   *  to the flat fields above for `twilio` and to null for everything else. */
  registrations?: Partial<
    Record<"twilio" | "cloud" | "bridge", WhatsappTemplateRegistrationField>
  > | null;
}

/** Mirrors `WhatsappTemplateRegistration` in the lib module; declared here so
 *  the type file stays free of a server-only import. */
export interface WhatsappTemplateRegistrationField {
  externalId: string | null;
  status: WhatsappTemplateStatus;
  rejectionReason: string | null;
  pollAttempts?: number;
  approvedAt?: Timestamp | FieldValue | null;
}

/** Merge tags a WhatsApp template variable may map to. A curated subset of
 *  the automation merge tags (unsubscribeLink is irrelevant to WhatsApp).
 *  Used to validate `variable.mergeTag` and to populate the builder picker. */
export const WHATSAPP_VARIABLE_MERGE_TAGS: ReadonlyArray<{
  tag: string;
  description: string;
}> = [
  { tag: "contact.firstName", description: "Contact's first name" },
  { tag: "contact.lastName", description: "Contact's last name" },
  { tag: "contact.email", description: "Contact's email address" },
  { tag: "contact.phone", description: "Contact's phone number" },
  { tag: "owner.firstName", description: "Agency owner's first name" },
  { tag: "workspace.name", description: "Sub-account / business name" },
  { tag: "bookingLink", description: "Booking page URL" },
];

/** A variable may also map to one of the sub-account's contact custom
 *  fields — `contact.customFields.<key>` — which the automation resolver
 *  already renders. Transactional templates need this: an install address or
 *  a job reference lives in a custom field, not a contact scalar. */
export const WHATSAPP_CUSTOM_FIELD_TAG_PREFIX = "contact.customFields.";

/** `contactCustomFieldKeys` is the sub-account's defined contact field keys.
 *  A custom-field tag is accepted only for a key in that set, so a typo is
 *  refused at save rather than rendering blank into every send. */
export function isWhatsappMergeTag(
  tag: string,
  contactCustomFieldKeys: ReadonlySet<string> = new Set(),
): boolean {
  if (tag.startsWith(WHATSAPP_CUSTOM_FIELD_TAG_PREFIX)) {
    return contactCustomFieldKeys.has(
      tag.slice(WHATSAPP_CUSTOM_FIELD_TAG_PREFIX.length),
    );
  }
  return WHATSAPP_VARIABLE_MERGE_TAGS.some((t) => t.tag === tag);
}
