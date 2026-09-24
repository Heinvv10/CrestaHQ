/**
 * One-off backfill: set `attentionOpen: true` on orders that were flagged
 * for attention before the `attentionOpen` field existed. The billing
 * attention list queries `.where("attentionOpen", "==", true)`, so a flagged
 * order without the field is invisible to operators until this runs.
 *
 * Run with Node 22 (scans every tenant — the field is missing everywhere):
 *   node --env-file=.env.local --experimental-strip-types \
 *     scripts/backfill-order-attention-open.ts [--write]
 *
 * Dry-run by default: reads only, prints counts. `--write` re-reads each row
 * inside a transaction (so a flag resolved by a live request in between is
 * skipped, not reopened) and sets only `attentionOpen: true`. Safe to rerun —
 * a second run plans zero changes.
 *
 * Rows with `attentionOpen` already present (true or false) or with
 * `attentionResolvedAt` set are counted and never touched.
 */
import { pathToFileURL } from "node:url";
import { cert, initializeApp } from "firebase-admin/app";
import {
  FieldPath,
  getFirestore,
  type Firestore,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";

const PAGE = 250;

export interface BackfillArgs {
  write: boolean;
}

export function parseArgs(argv: string[]): BackfillArgs {
  return { write: argv.includes("--write") };
}

export interface BackfillResult {
  write: boolean;
  scanned: number;
  /** Flagged, unresolved, and missing `attentionOpen`. */
  candidates: number;
  /** `attentionOpen` already present (true or false). */
  alreadySet: number;
  /** `attentionResolvedAt` set — never reopened. */
  alreadyResolved: number;
  written: number;
}

/** True when the row is flagged, unresolved, and has no `attentionOpen` yet. */
export function needsAttentionOpen(data: Record<string, unknown>): boolean {
  const attention = data.attention;
  if (typeof attention !== "string" || attention.trim() === "") return false;
  if (data.attentionOpen !== undefined) return false;
  if (data.attentionResolvedAt !== null && data.attentionResolvedAt !== undefined)
    return false;
  return true;
}

export async function backfillOrderAttentionOpen(
  db: Firestore,
  args: BackfillArgs
): Promise<BackfillResult> {
  const r: BackfillResult = {
    write: args.write,
    scanned: 0,
    candidates: 0,
    alreadySet: 0,
    alreadyResolved: 0,
    written: 0,
  };
  let after: QueryDocumentSnapshot | undefined;
  for (;;) {
    // An inequality filter must be ordered by its own field first.
    let q = db
      .collection("orders")
      .where("attention", "!=", null)
      .orderBy("attention")
      .orderBy(FieldPath.documentId())
      .limit(PAGE);
    if (after) q = q.startAfter(after);
    const page = await q.get();
    for (const row of page.docs) {
      r.scanned++;
      const data = row.data();
      if (data.attentionOpen !== undefined) {
        r.alreadySet++;
        continue;
      }
      if (data.attentionResolvedAt !== null && data.attentionResolvedAt !== undefined) {
        r.alreadyResolved++;
        continue;
      }
      if (!needsAttentionOpen(data)) continue;
      r.candidates++;
      if (!args.write) continue;
      const wrote = await db.runTransaction(async (tx) => {
        const current = await tx.get(row.ref);
        if (!current.exists || !needsAttentionOpen(current.data()!)) return false;
        tx.update(row.ref, { attentionOpen: true });
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
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
      clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
  console.log(
    JSON.stringify(await backfillOrderAttentionOpen(getFirestore(), args))
  );
}
