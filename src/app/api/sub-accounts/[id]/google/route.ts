import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { clearListing } from "@/lib/gbp/listing-events";
import { fakeProviderAllowed } from "@/lib/gbp/provider/mode";
import { isLoopbackOrUnparseableUrl } from "@/lib/gbp/provider/loopback.mjs";
import { assertFakeFixtureAgency, getGbpProviderFor } from "@/lib/gbp/provider/select";
import type { GbpProvider } from "@/lib/gbp/provider/types";
import {
  googleConnectionSecretPath,
  type GoogleConnectionSecret,
} from "@/types/google";

/**
 * Disconnect the Google Business Profile connection for a sub-account.
 *
 *   DELETE /api/sub-accounts/[id]/google
 *
 * Sub-account admin only. Deliberately UNGATED on the agency flag so a
 * connection can always be cleaned up, even after the agency switched the
 * feature off. Revokes at Google best-effort, then deletes the locked secret
 * doc and clears the display metadata and the chosen listing. Re-connecting is
 * a fresh OAuth pass.
 */

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;

  // Before any read or write: an ALLOWED fake throws in getGbpProviderFor for
  // a sub-account outside the fixture agency, so a dev pointed at production
  // Firestore cannot delete a real tenant's connection.
  //
  // A fake that is requested but REFUSED leaves no provider to revoke with —
  // revoke is best-effort, so the local disconnect still goes ahead (it is the
  // "not configured" state's Disconnect button). On a dev machine (loopback
  // app URL) that machine still points at production Firestore, so the
  // fixture-agency fence applies first; on a misconfigured deployment (public
  // URL) the tenant is the deployment's own, so it simply clears.
  const fakeRefused = process.env.GBP_PROVIDER === "fake" && !fakeProviderAllowed();
  let provider: GbpProvider | null = null;
  if (fakeRefused) {
    // WIDE rule: when in doubt (0.0.0.0, *.localhost, an unparseable URL) treat
    // it as a dev machine and apply the fence — failing toward fencing.
    if (isLoopbackOrUnparseableUrl(process.env.NEXT_PUBLIC_APP_URL)) await assertFakeFixtureAgency(id);
    console.warn(`[google/disconnect] fake provider refused here; skipping revoke sa=${id}`);
  } else {
    provider = await getGbpProviderFor(id);
  }

  const db = getAdminDb();
  const secretRef = db.doc(googleConnectionSecretPath(id));
  const snap = await secretRef.get();
  const secret = snap.exists
    ? (snap.data() as GoogleConnectionSecret)
    : null;

  // Best-effort — a failed revoke must never block the local disconnect, or
  // the operator is stuck with a connection they can't remove.
  if (provider && secret?.refreshToken) {
    try {
      await provider.revoke(secret.refreshToken);
    } catch (err) {
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : typeof err;
      console.warn(`[google/disconnect] revoke failed sa=${id}`, reason);
    }
  }

  await secretRef.delete();
  // The listing belongs to the connection it was picked through; clearing it
  // is audited (reason "disconnected") in the same write as the meta.
  await clearListing(id, access.uid, "disconnected", {
    alsoSet: { googleConnectionMeta: null },
  });

  return NextResponse.json({ ok: true });
}
