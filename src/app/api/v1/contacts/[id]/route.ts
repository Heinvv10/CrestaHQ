import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { withApiAuth } from "@/lib/api/auth";
import { apiError, apiOk } from "@/lib/api/responses";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import {
  openEnrolmentGate,
  releaseReservation,
} from "@/lib/api/enrolment-cap";
import {
  parseContactPatch,
  serializeContactForApi,
} from "@/lib/api/serializers/contacts";
import {
  updateContactServerSide,
  type UpdateContactPatch,
} from "@/lib/server/contacts-service";
import { loadCustomFieldDefs } from "@/lib/custom-fields/load-defs";
import { prospectingEnabled } from "@/lib/prospecting/gate";
import type { SubAccountDoc } from "@/types";
import { validateCustomFieldValues } from "@/lib/custom-fields/validation";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * Public API v1: single-contact routes.
 *
 *   GET    /api/v1/contacts/:id   — fetch
 *   PATCH  /api/v1/contacts/:id   — partial update (any subset of writable fields)
 *   DELETE /api/v1/contacts/:id   — delete (and unlink referencing deals/tasks/events,
 *                                   same cleanup as the dashboard delete route)
 *
 * Tenancy enforcement: every operation re-reads the doc and verifies
 * `data.subAccountId === ctx.subAccountId` AND `data.mode === ctx.mode`.
 * Cross-tenant / cross-mode access returns 404 (not 403) — we never reveal
 * whether the id exists in another scope.
 *
 * Webhook emission: contact.updated fires on PATCH, contact.deleted on
 * DELETE. The dispatcher is fire-and-forget; failures don't roll back the
 * write.
 *
 * PATCH goes through `updateContactServerSide` — the same chokepoint the
 * dashboard uses — so an API tag add fires `contact.tag.added` exactly like
 * a tag added in the UI. The tag diff lives THERE, in one place; this route
 * never re-implements it. Test-mode writes fire no triggers (gate in the
 * service).
 */

export const GET = withApiAuth<{ id: string }>(async ({ params, ctx }) => {
  const snap = await getAdminDb().doc(`contacts/${params.id}`).get();
  if (!snap.exists) {
    return apiError(ctx, "not_found", "contact_not_found", "Contact not found.");
  }
  const data = snap.data()!;
  if (data.subAccountId !== ctx.subAccountId || data.mode !== ctx.mode) {
    return apiError(ctx, "not_found", "contact_not_found", "Contact not found.");
  }
  return apiOk(ctx, {
    contact: serializeContactForApi(snap.id, data, ctx.mode),
  });
});

export const PATCH = withApiAuth<{ id: string }>(async ({ body, params, ctx }) => {
  const parsed = parseContactPatch(body);
  if (!parsed.ok) {
    return apiError(ctx, "invalid_request", parsed.code ?? "invalid_body", parsed.error!);
  }
  // `parseContactPatch` already emits the internal camelCase field names,
  // which is exactly the service's patch shape. It never populates
  // `customFields` — custom_fields is validated against the live defs
  // below — so the create shape's nullable variant is dropped here.
  const { customFields: _cfFromBody, ...patchFields } = parsed.value!;
  const patch: UpdateContactPatch = patchFields;

  const snap = await getAdminDb().doc(`contacts/${params.id}`).get();
  if (!snap.exists) {
    return apiError(ctx, "not_found", "contact_not_found", "Contact not found.");
  }
  const existing = snap.data()!;
  if (existing.subAccountId !== ctx.subAccountId || existing.mode !== ctx.mode) {
    return apiError(ctx, "not_found", "contact_not_found", "Contact not found.");
  }

  // The prospecting map needs the agency's Prospecting gate, and a list_id
  // must name one of this key's lists — another sub-account's list 404s
  // exactly like a missing one.
  if (patch.prospecting !== undefined) {
    const db = getAdminDb();
    const sub = (await db.doc(`subAccounts/${ctx.subAccountId}`).get()).data();
    if (!sub || !prospectingEnabled(sub as SubAccountDoc)) {
      return apiError(ctx, "permission_error", "gate_off", "Prospecting is locked by your agency.");
    }
    if (patch.prospecting.listId !== undefined) {
      const list = await db.doc(`prospectLists/${patch.prospecting.listId}`).get();
      if (!list.exists || list.data()?.subAccountId !== ctx.subAccountId) {
        return apiError(ctx, "not_found", "list_not_found", "List not found.");
      }
    }
  }

  // custom_fields is a full replacement of the value map when provided.
  if ((body as Record<string, unknown>).custom_fields !== undefined) {
    const cfDefs = await loadCustomFieldDefs(ctx.subAccountId, "contact");
    const cf = validateCustomFieldValues(
      (body as Record<string, unknown>).custom_fields,
      cfDefs,
    );
    if (!cf.ok) {
      return apiError(ctx, "invalid_request", "invalid_body", cf.error!);
    }
    patch.customFields = cf.value;
  }

  // Reserve BEFORE the write when this key has budget left — a tag add that
  // silently enrolled nobody would be the quiet failure this cap exists to
  // prevent. From here on this request OWNS a reservation: the service tells
  // us whether it fired a trigger (it owns the tag diff, and re-deriving it
  // here is exactly what this design avoids), and every path that did NOT
  // fire releases the reservation explicitly.
  const gate = await openEnrolmentGate(ctx);
  if (gate.refusal) return gate.refusal;

  let written;
  try {
    written = await updateContactServerSide({
      contactId: params.id,
      patch,
      mode: ctx.mode,
      apiKeyId: ctx.keyId,
    });
  } catch (err) {
    // withApiAuth turns this into a 500; without the release the slot would
    // be held for the rest of the hour by a request that never enrolled.
    await releaseReservation(gate);
    throw err;
  }

  // Covers BOTH no-trigger cases: a patch that added no new tag, and a
  // contact that vanished between the tenancy read and the write.
  if (!written?.firedTrigger) await releaseReservation(gate);

  if (!written) {
    return apiError(ctx, "not_found", "contact_not_found", "Contact not found.");
  }

  return apiOk(ctx, { contact: written.contact });
});

export const DELETE = withApiAuth<{ id: string }>(async ({ params, ctx }) => {
  const db = getAdminDb();
  const ref = db.doc(`contacts/${params.id}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return apiError(ctx, "not_found", "contact_not_found", "Contact not found.");
  }
  const existing = snap.data()!;
  if (existing.subAccountId !== ctx.subAccountId || existing.mode !== ctx.mode) {
    return apiError(ctx, "not_found", "contact_not_found", "Contact not found.");
  }

  // Mirror the dashboard delete cleanup (see src/app/api/contacts/[id]/route.ts):
  //   1. Recursive-delete the contact + subcollections (notes, activities).
  //   2. Delete deals that reference the contact.
  //   3. Null-out contactId on tasks + events (preserve standalone usefulness).
  await db.recursiveDelete(ref);

  // Same-mode filter on the cascade so live deletes don't blow away test
  // deals and vice-versa.
  const dealsSnap = await db
    .collection("deals")
    .where("subAccountId", "==", ctx.subAccountId)
    .where("mode", "==", ctx.mode)
    .where("contactId", "==", params.id)
    .get();
  if (!dealsSnap.empty) {
    const batch = db.batch();
    for (const d of dealsSnap.docs) batch.delete(d.ref);
    await batch.commit();
  }

  for (const collection of ["tasks", "events"] as const) {
    const s = await db
      .collection(collection)
      .where("subAccountId", "==", ctx.subAccountId)
      .where("mode", "==", ctx.mode)
      .where("contactId", "==", params.id)
      .get();
    if (s.empty) continue;
    const batch = db.batch();
    for (const d of s.docs) batch.update(d.ref, { contactId: null });
    await batch.commit();
  }

  runAfterResponse(() => emitWebhookEvent({
    subAccountId: ctx.subAccountId,
    agencyId: ctx.agencyId,
    mode: ctx.mode,
    type: "contact.deleted",
    payload: {
      contact: { id: params.id, object: "contact", deleted: true },
    },
  }));

  return apiOk(ctx, { id: params.id, object: "contact", deleted: true });
});
