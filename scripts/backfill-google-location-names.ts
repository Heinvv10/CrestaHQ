/**
 * Backfill `googleLocationNames` on sub-accounts (MULTI_LISTING_V1_PLAN.md,
 * PR 1). The `listing_shared` check (src/lib/gbp/shared-location.ts) runs an
 * equality query on `googleListing.locationName` AND an `array-contains` query
 * on `googleLocationNames`, so nothing depends on this having run; it lets the
 * equality query be retired later.
 *
 * Order: deploy the app first (every listing writer then keeps the field
 * current), THEN run this.
 *
 * Run with Node 22:
 *   node --env-file=.env.local --experimental-strip-types \
 *     scripts/backfill-google-location-names.ts --project <firebase-project-id> [--apply]
 *
 * Dry-run by default: reads only, prints counts. `--project` is required and
 * must match the credential's project, so a wrong env file can't write to
 * the wrong database. `--apply` re-reads each planned doc in a transaction (a
 * live edit in between is re-planned, not overwritten) and writes only
 * `googleLocationNames`, only where the field is absent and a listing exists.
 * Safe to rerun — a second run plans zero writes.
 */
import { pathToFileURL } from "node:url";
import { cert, initializeApp } from "firebase-admin/app";
import {
  FieldPath,
  getFirestore,
  type Firestore,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import { locationNamesOf, type ListingFields } from "../src/lib/gbp/listings.ts";

const PAGE = 500;

export interface BackfillArgs {
  projectId: string;
  apply: boolean;
}

export function parseArgs(argv: string[]): BackfillArgs {
  const i = argv.indexOf("--project");
  const projectId = i >= 0 ? (argv[i + 1] ?? "") : "";
  if (!projectId || projectId.startsWith("--"))
    throw new Error("--project <firebase-project-id> is required");
  return { projectId, apply: argv.includes("--apply") };
}

/** The `googleLocationNames` to write, or null: already present (any value), or no listing. */
export function planLocationNames(data: Record<string, unknown>): string[] | null {
  if (data.googleLocationNames !== undefined) return null;
  const names = locationNamesOf(data as ListingFields);
  if (names.length === 0 || names.some((n) => typeof n !== "string" || !n)) return null;
  return names;
}

export interface BackfillResult {
  apply: boolean;
  scanned: number;
  planned: number;
  written: number;
}

export async function backfillGoogleLocationNames(
  db: Firestore,
  apply: boolean
): Promise<BackfillResult> {
  const r: BackfillResult = { apply, scanned: 0, planned: 0, written: 0 };
  let after: QueryDocumentSnapshot | undefined;
  for (;;) {
    let q = db
      .collection("subAccounts")
      .select("googleListing", "googleExtraListings", "googleLocationNames")
      .orderBy(FieldPath.documentId())
      .limit(PAGE);
    if (after) q = q.startAfter(after);
    const page = await q.get();
    for (const row of page.docs) {
      r.scanned++;
      if (planLocationNames(row.data()) === null) continue;
      r.planned++;
      if (!apply) continue;
      const wrote = await db.runTransaction(async (tx) => {
        const current = await tx.get(row.ref);
        if (!current.exists) return false;
        const fresh = planLocationNames(current.data()!);
        if (fresh === null) return false;
        tx.update(row.ref, { googleLocationNames: fresh });
        return true;
      });
      if (wrote) r.written++;
    }
    if (page.docs.length < PAGE) break;
    after = page.docs[page.docs.length - 1];
  }
  return r;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = parseArgs(process.argv.slice(2));
  const envProject = process.env.FIREBASE_ADMIN_PROJECT_ID;
  if (envProject !== args.projectId) {
    throw new Error(
      `--project ${args.projectId} does not match the credential's project (${envProject ?? "unset"})`
    );
  }
  initializeApp({
    projectId: args.projectId,
    credential: cert({
      projectId: envProject,
      clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
  console.log(JSON.stringify(await backfillGoogleLocationNames(getFirestore(), args.apply)));
}
