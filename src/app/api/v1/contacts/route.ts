import "server-only";

import { type Query } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { withApiAuth } from "@/lib/api/auth";
import { apiError, apiOk } from "@/lib/api/responses";
import {
  openEnrolmentGate,
  releaseReservation,
} from "@/lib/api/enrolment-cap";
import {
  parseContactCreate,
  serializeContactForApi,
} from "@/lib/api/serializers/contacts";
import { createContactServerSide } from "@/lib/server/contacts-service";
import { loadCustomFieldDefs } from "@/lib/custom-fields/load-defs";
import { validateCustomFieldValues } from "@/lib/custom-fields/validation";

/**
 * Public API v1: Contacts collection-level routes.
 *
 *   GET  /api/v1/contacts                  — list (cursor pagination)
 *        ?limit=20&starting_after=<id>
 *   POST /api/v1/contacts                  — create
 *
 * Tenancy: every contact carries `agencyId` + `subAccountId` + `mode` and
 * is filtered strictly by `subAccountId` (from `ctx`) AND `mode` (from
 * `ctx`). Test-mode requests can NEVER read or write live contacts and
 * vice-versa — the wall is enforced in code, not rules (writes go via
 * Admin SDK).
 *
 * Pagination: `starting_after` is a contact id. The route reads that doc's
 * `createdAt` and uses it as the Firestore cursor. Default limit 20, max
 * 100. Returns `has_more: true` when the next page would have results.
 *
 * Writes go through `createContactServerSide` — the same chokepoint the
 * dashboard uses — so an API create fires `contact.created` (webhook AND
 * workflow trigger) exactly like a create from the UI. Test-mode writes
 * fire no triggers; that gate lives in the service.
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export const GET = withApiAuth(async ({ request, ctx }) => {
  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(limitRaw)))
    : DEFAULT_LIMIT;
  const startingAfter = url.searchParams.get("starting_after");

  const db = getAdminDb();
  let q: Query = db
    .collection("contacts")
    .where("subAccountId", "==", ctx.subAccountId)
    .where("mode", "==", ctx.mode)
    .orderBy("createdAt", "desc");

  if (startingAfter) {
    const cursorSnap = await db.doc(`contacts/${startingAfter}`).get();
    if (!cursorSnap.exists) {
      return apiError(
        ctx,
        "invalid_request",
        "invalid_cursor",
        `starting_after=${startingAfter} not found.`,
      );
    }
    const cursor = cursorSnap.data()!;
    if (cursor.subAccountId !== ctx.subAccountId || cursor.mode !== ctx.mode) {
      return apiError(
        ctx,
        "invalid_request",
        "invalid_cursor",
        "Cursor belongs to a different sub-account or mode.",
      );
    }
    q = q.startAfter(cursor.createdAt);
  }

  // Fetch limit + 1 to know if there's another page without a second query.
  const snap = await q.limit(limit + 1).get();
  const docs = snap.docs.slice(0, limit);
  const hasMore = snap.docs.length > limit;
  const data = docs.map((d) =>
    serializeContactForApi(d.id, d.data(), ctx.mode),
  );

  return apiOk(ctx, {
    object: "list",
    data,
    has_more: hasMore,
    url: "/v1/contacts",
  });
});

export const POST = withApiAuth(async ({ body, ctx }) => {
  const parsed = parseContactCreate(body);
  if (!parsed.ok) {
    return apiError(ctx, "invalid_request", "invalid_body", parsed.error!);
  }
  const input = parsed.value!;

  // Validate any custom_fields against the sub-account's contact definitions.
  const cfDefs = await loadCustomFieldDefs(ctx.subAccountId, "contact");
  const cf = validateCustomFieldValues(
    (body as Record<string, unknown>).custom_fields,
    cfDefs,
  );
  if (!cf.ok) {
    return apiError(ctx, "invalid_request", "invalid_body", cf.error!);
  }

  // Reserve BEFORE the write when this key has budget left — a runaway
  // script must fail loudly, not create contacts whose automations silently
  // didn't run. From here on this request OWNS a reservation, and every exit
  // path below either fires a trigger (whose `finally` settles it) or
  // releases it explicitly.
  //
  // Create has no un-fired path to release: a live-mode create ALWAYS fires
  // `contact.created`, and live mode is exactly when a reservation is
  // charged — so the trigger's `finally` always owns it. That invariant is
  // pinned by a test; PATCH, whose trigger is conditional on a tag diff,
  // needs the explicit release this route does not.
  const gate = await openEnrolmentGate(ctx);
  if (gate.refusal) return gate.refusal;

  let written;
  try {
    // Workspace default country for lenient phone normalization — same read
    // the dashboard create route does, so an API-created contact's phone is
    // stored in the same shape as a UI-created one.
    const subSnap = await getAdminDb()
      .doc(`subAccounts/${ctx.subAccountId}`)
      .get();

    written = await createContactServerSide({
      subAccountId: ctx.subAccountId,
      agencyId: ctx.agencyId,
      // `createdByUid` carries the API key prefix so audit trails can
      // distinguish dashboard creates from API creates. Same column the
      // dashboard would have used for a Firebase Auth uid — readers don't
      // need to special-case it.
      createdByUid: `apikey:${ctx.keyPrefix}`,
      mode: ctx.mode,
      name: input.name,
      email: input.email,
      phone: input.phone,
      phoneCountry: (subSnap.data()?.defaultPhoneCountry as string) ?? null,
      company: input.company,
      address: input.address,
      source: input.source,
      tags: input.tags,
      pipelineStage: input.pipelineStage,
      territoryId: input.territoryId,
      customFields: cf.value,
      apiKeyId: ctx.keyId,
    });
  } catch (err) {
    // withApiAuth turns this into a 500; without the release the slot would
    // be held for the rest of the hour by a request that never enrolled.
    await releaseReservation(gate);
    throw err;
  }

  return apiOk(ctx, { contact: written.contact }, { status: 201 });
});
