import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { withApiAuth } from "@/lib/api/auth";
import { apiError, apiOk } from "@/lib/api/responses";
import {
  parseLinkCreate,
  serializeLinkForApi,
} from "@/lib/api/serializers/links";
import { DEFAULT_TRACKED_LINK } from "@/types/tracked-links";

/**
 * Public API v1: tracked links.
 *
 *   POST /api/v1/links — create a link
 *
 * Tenancy: the link is stamped with the key's `agencyId` + `subAccountId`
 * + `mode`. Test-mode links record clicks but never enrol a contact in a
 * workflow — see lib/tracked-links/click.ts.
 */
export const POST = withApiAuth(async ({ body, ctx }) => {
  const parsed = parseLinkCreate(body);
  if (!parsed.ok) {
    return apiError(ctx, "invalid_request", "invalid_body", parsed.error!);
  }
  const input = parsed.value!;

  const ref = getAdminDb().collection("trackedLinks").doc();
  await ref.set({
    ...DEFAULT_TRACKED_LINK,
    name: input.name,
    destinationUrl: input.destinationUrl,
    agencyId: ctx.agencyId,
    subAccountId: ctx.subAccountId,
    createdByUid: `apikey:${ctx.keyPrefix}`,
    mode: ctx.mode,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const created = await ref.get();
  return apiOk(
    ctx,
    { link: serializeLinkForApi(created.id, created.data()!, ctx.mode) },
    { status: 201 },
  );
});
