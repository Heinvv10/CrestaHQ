/**
 * Backfill `isLong` on existing calendar events (see
 * src/lib/booking/long-event.ts). Availability reads events longer than 8 h
 * through a query on `(subAccountId, isLong, startAt)`, so a long event
 * written before the flag existed is invisible to it until this has run.
 *
 * Order: deploy firestore.indexes.json and let the index build, deploy the
 * app, THEN run this — an event written by old code between a backfill and
 * the app deploy would be missed.
 *
 * Run with Node 22:
 *   node --env-file=.env.local --experimental-strip-types \
 *     scripts/backfill-event-is-long.ts --project <firebase-project-id> [--apply]
 *
 * Dry-run by default: reads only, prints counts. `--project` is required and
 * must match the credential's project, so a wrong env file can't write to
 * the wrong database. `--apply` re-reads each event that needs a change in a
 * transaction (a live edit in between is re-planned, not overwritten) and
 * writes only `isLong`. Safe to rerun — a second run plans zero changes.
 * Short events without the flag are left alone: absent reads as false.
 */
import { pathToFileURL } from "node:url";
import { cert, initializeApp } from "firebase-admin/app";
import {
  FieldPath,
  getFirestore,
  type Firestore,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import { isLongEvent } from "../src/lib/booking/long-event.ts";

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

/** The `isLong` to write, or null when the stored value is already right. */
export function planIsLong(data: Record<string, unknown>): boolean | null {
  const want = isLongEvent(data.startAt, data.endAt);
  const has = data.isLong === true;
  if (want === has) return null;
  return want;
}

export interface BackfillResult {
  apply: boolean;
  scanned: number;
  /** Events that should be flagged long and are not. */
  toLong: number;
  /** Events flagged long that no longer are. */
  toShort: number;
  written: number;
}

export async function backfillEventIsLong(
  db: Firestore,
  apply: boolean
): Promise<BackfillResult> {
  const r: BackfillResult = { apply, scanned: 0, toLong: 0, toShort: 0, written: 0 };
  let after: QueryDocumentSnapshot | undefined;
  for (;;) {
    let q = db
      .collection("events")
      .select("startAt", "endAt", "isLong")
      .orderBy(FieldPath.documentId())
      .limit(PAGE);
    if (after) q = q.startAfter(after);
    const page = await q.get();
    for (const row of page.docs) {
      r.scanned++;
      const plan = planIsLong(row.data());
      if (plan === null) continue;
      if (plan) r.toLong++;
      else r.toShort++;
      if (!apply) continue;
      const wrote = await db.runTransaction(async (tx) => {
        const current = await tx.get(row.ref);
        if (!current.exists) return false;
        const fresh = planIsLong(current.data()!);
        if (fresh === null) return false;
        tx.update(row.ref, { isLong: fresh });
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
  console.log(JSON.stringify(await backfillEventIsLong(getFirestore(), args.apply)));
}
