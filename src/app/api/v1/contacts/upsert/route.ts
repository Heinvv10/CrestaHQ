import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { withApiAuth } from "@/lib/api/auth";
import { apiError, apiOk } from "@/lib/api/responses";
import {
  openEnrolmentGate,
  releaseReservation,
  type EnrolmentGate,
} from "@/lib/api/enrolment-cap";
import { asTags, parseContactPatch } from "@/lib/api/serializers/contacts";
import { loadCustomFieldDefs } from "@/lib/custom-fields/load-defs";
import { validateCustomFieldValues } from "@/lib/custom-fields/validation";
import { normalizePhoneE164 } from "@/lib/contacts/phone";
import { upsertContactByPhone } from "@/lib/server/contact-upsert";
import { describeEnrolment } from "@/lib/api/serializers/enrolment";
import type { CustomFieldValue } from "@/types/custom-fields";

/**
 * POST /api/v1/contacts/upsert — create-or-update a contact, the phone as
 * its identity. Calling it twice with the same phone yields one contact.
 *
 *   phone          required; normalised to E.164 (workspace default country)
 *   name, email, company, address, source   optional; only sent keys written
 *                  (`name` is required when the call creates the contact)
 *   custom_fields  optional; MERGED per key into the existing values — a key
 *                  sent as null or "" is cleared, a key not sent is kept.
 *                  An unknown key is refused, not dropped.
 *   tags_add / tags_remove   optional; applied to the contact's current tags.
 *                  `tags` (whole-array replace) is refused here.
 *
 * 201 when the contact was created, 200 when updated, 409 `ambiguous_phone`
 * when more than one contact already holds the phone (nothing is written).
 *
 * When `tags_add` is sent, the response carries `enrolment` — the run ids the
 * tag started, or the one reason it started none — decided before the
 * response is written. There is nothing to poll and no acknowledgement tag.
 * Null when no tags were added.
 * `Idempotency-Key` is honoured by withApiAuth like every v1 POST.
 *
 * Enrolment fuse: a create fires `contact.created` AND, if it adds tags,
 * `contact.tag.added` — so the request reserves one slot per trigger it can
 * fire, before any write, and hands back whichever did not fire.
 */

function parseCustomFieldPatch(
  raw: unknown,
  defs: Awaited<ReturnType<typeof loadCustomFieldDefs>>,
): { ok: true; value: Record<string, CustomFieldValue | null> } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "`custom_fields` must be an object." };
  }
  const sent = raw as Record<string, unknown>;
  const known = new Set(defs.map((d) => d.key));
  const unknown = Object.keys(sent).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown custom field key(s): ${unknown.join(", ")}.` };
  }
  // Validate only the keys sent: a merge must not demand every required
  // field on every call. Required fields are enforced when creating.
  const checked = validateCustomFieldValues(
    sent,
    defs.filter((d) => d.key in sent).map((d) => ({ ...d, required: false })),
  );
  if (!checked.ok) return checked;
  const value: Record<string, CustomFieldValue | null> = {};
  for (const k of Object.keys(sent)) value[k] = checked.value[k] ?? null;
  return { ok: true, value };
}

export const POST = withApiAuth(async ({ body, ctx }) => {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return apiError(ctx, "invalid_request", "invalid_body", "Body must be a JSON object.");
  }
  for (const field of ["pipeline_stage", "territory_id"]) {
    if (b[field] !== undefined) {
      return apiError(ctx, "invalid_request", "invalid_body",
        `\`${field}\` is not supported on upsert. Set it with PATCH /v1/contacts/:id.`);
    }
  }
  if (b.tags !== undefined) {
    return apiError(ctx, "invalid_request", "invalid_body",
      "`tags` replaces the whole array and is not accepted here. Use `tags_add` / `tags_remove`.");
  }
  const scalars = parseContactPatch({ ...b, phone: undefined, tags: undefined });
  if (!scalars.ok) return apiError(ctx, "invalid_request", "invalid_body", scalars.error!);
  const tagsAdd = asTags(b.tags_add);
  const tagsRemove = asTags(b.tags_remove);
  if (tagsAdd === null || tagsRemove === null) {
    return apiError(ctx, "invalid_request", "invalid_body",
      "`tags_add` and `tags_remove` must be arrays of non-empty strings (≤80 chars, max 50).");
  }
  const both = tagsAdd.filter((t) => tagsRemove.includes(t));
  if (both.length > 0) {
    return apiError(ctx, "invalid_request", "invalid_body",
      `Tag(s) in both tags_add and tags_remove: ${both.join(", ")}.`);
  }

  const sub = (await getAdminDb().doc(`subAccounts/${ctx.subAccountId}`).get()).data();
  const phone = normalizePhoneE164(
    typeof b.phone === "string" ? b.phone : "",
    (sub?.defaultPhoneCountry as string | undefined) ?? null,
  );
  if (!phone) {
    return apiError(ctx, "invalid_request", "invalid_phone",
      "`phone` is required and must be a valid phone number.");
  }

  const defs = await loadCustomFieldDefs(ctx.subAccountId, "contact");
  const cf = parseCustomFieldPatch(b.custom_fields, defs);
  if (!cf.ok) return apiError(ctx, "invalid_request", "invalid_body", cf.error);

  const { name, email, company, address, source } = scalars.value!;
  const fields = Object.fromEntries(
    Object.entries({ name, email, company, address, source }).filter(([, v]) => v !== undefined),
  ) as Record<"name" | "email" | "company" | "address" | "source", string>;

  // One slot per trigger this request can fire; see the header.
  const gates: EnrolmentGate[] = [];
  for (let i = 0; i < (tagsAdd.length > 0 ? 2 : 1); i++) {
    const gate = await openEnrolmentGate(ctx);
    if (gate.refusal) {
      for (const g of gates) await releaseReservation(g);
      return gate.refusal;
    }
    gates.push(gate);
  }

  let outcome;
  try {
    outcome = await upsertContactByPhone({
      subAccountId: ctx.subAccountId,
      agencyId: ctx.agencyId,
      mode: ctx.mode,
      createdByUid: `apikey:${ctx.keyPrefix}`,
      apiKeyId: ctx.keyId,
      phone,
      fields,
      customFields: cf.value,
      requiredCustomFields: defs.filter((d) => d.required),
      tagsAdd,
      tagsRemove,
    });
  } catch (err) {
    for (const g of gates) await releaseReservation(g);
    throw err;
  }

  // Each fired trigger settles one reservation in its own `finally`; the
  // rest were never used and go back now.
  const fired = "triggers" in outcome ? outcome.triggers.length : 0;
  for (const g of gates.slice(fired)) await releaseReservation(g);

  if (outcome.kind === "ambiguous") {
    return apiError(ctx, "invalid_request", "ambiguous_phone",
      `More than one contact already has this phone (${outcome.contactIds.join(", ")}). Nothing was written; merge them, then retry.`,
      { status: 409 });
  }
  if (outcome.kind === "refused") {
    return apiError(ctx, "invalid_request", "invalid_body", outcome.error);
  }
  // Awaited, not polled: the enrolment is finished (runs written, first
  // step handed to QStash) before the response goes out.
  const tagTrigger = outcome.triggers.find((t) => t.type === "contact.tag.added");
  const enrolment =
    tagsAdd.length > 0
      ? describeEnrolment({
          mode: ctx.mode,
          tagTrigger: tagTrigger ? await tagTrigger.outcome : null,
        })
      : null;
  return apiOk(
    ctx,
    { contact: outcome.contact, created: outcome.kind === "created", enrolment },
    { status: outcome.kind === "created" ? 201 : 200 },
  );
});
