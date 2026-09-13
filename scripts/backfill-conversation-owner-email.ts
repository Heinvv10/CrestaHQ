/**
 * SP2 (b) backfill: stamp the owner + email mirror (`assigneeUid`,
 * `contactEmail`) onto conversation rows written before the mirror existed.
 * The contact is the source of truth; see src/lib/server/conversation-mirror.ts.
 *
 * Run with Node 22, ONE sub-account at a time:
 *   node --env-file=.env.local --experimental-strip-types \
 *     scripts/backfill-conversation-owner-email.ts --sub-account <id> [--write]
 *
 * Dry-run by default: reads only, prints counts. `--write` re-reads each row
 * that needs a change inside a transaction (so a mirror written by a live
 * request in between is re-planned, not overwritten) and patches only the two
 * mirror fields. Safe to rerun — a second run plans zero changes.
 *
 * A conversation whose contact is missing or in another tenant is counted as
 * orphaned and never touched.
 */
import { pathToFileURL } from "node:url";
import { cert, initializeApp } from "firebase-admin/app";
import {
  FieldPath,
  getFirestore,
  type Firestore,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import { planConversationMirror } from "../src/lib/conversations/mirror-plan.ts";

const PAGE = 250;

export interface BackfillArgs {
  subAccountId: string;
  write: boolean;
}

/** `--sub-account <id>` is required for dry-run and write alike. */
export function parseArgs(argv: string[]): BackfillArgs {
  const i = argv.indexOf("--sub-account");
  const subAccountId = i >= 0 ? (argv[i + 1] ?? "") : "";
  if (!subAccountId || subAccountId.startsWith("--"))
    throw new Error("--sub-account <id> is required");
  return { subAccountId, write: argv.includes("--write") };
}

export interface BackfillResult {
  subAccountId: string;
  write: boolean;
  scanned: number;
  /** Rows whose mirror differs from their contact. */
  changed: number;
  /** Of those, rows that gain / lose / change an owner. */
  ownerChanges: number;
  /** Of those, rows whose contactEmail changes. */
  emailChanges: number;
  unchanged: number;
  /** Anonymous web-chat rows — no contact to mirror. */
  anonymous: number;
  /** Contact missing or in another tenant — never patched. */
  orphaned: number;
  written: number;
}

export async function backfillConversationOwnerEmail(
  db: Firestore,
  args: BackfillArgs
): Promise<BackfillResult> {
  const r: BackfillResult = {
    subAccountId: args.subAccountId,
    write: args.write,
    scanned: 0,
    changed: 0,
    ownerChanges: 0,
    emailChanges: 0,
    unchanged: 0,
    anonymous: 0,
    orphaned: 0,
    written: 0,
  };
  let after: QueryDocumentSnapshot | undefined;
  for (;;) {
    let q = db
      .collection("conversations")
      .where("subAccountId", "==", args.subAccountId)
      .orderBy(FieldPath.documentId())
      .limit(PAGE);
    if (after) q = q.startAfter(after);
    const page = await q.get();
    const contactIds = page.docs
      .map((d) => d.data().contactId)
      .filter((id): id is string => typeof id === "string" && !id.includes("/"));
    const contacts = new Map<string, Record<string, unknown> | undefined>();
    if (contactIds.length > 0) {
      const snaps = await db.getAll(
        ...[...new Set(contactIds)].map((id) => db.doc(`contacts/${id}`))
      );
      for (const s of snaps) contacts.set(s.id, s.data());
    }
    for (const row of page.docs) {
      r.scanned++;
      const convo = row.data();
      const cid = convo.contactId;
      if (cid === null || cid === undefined) {
        r.anonymous++;
        continue;
      }
      const plan = planConversationMirror(
        convo,
        typeof cid === "string" ? contacts.get(cid) : undefined
      );
      if (plan.orphaned) {
        r.orphaned++;
        continue;
      }
      if (!plan.patch) {
        r.unchanged++;
        continue;
      }
      r.changed++;
      if (plan.patch.assigneeUid !== (convo.assigneeUid ?? null))
        r.ownerChanges++;
      if (plan.patch.contactEmail !== (convo.contactEmail ?? null))
        r.emailChanges++;
      if (!args.write) continue;
      const wrote = await db.runTransaction(async (tx) => {
        const current = await tx.get(row.ref);
        if (!current.exists) return false;
        const data = current.data()!;
        const contact =
          typeof data.contactId === "string"
            ? (await tx.get(db.doc(`contacts/${data.contactId}`))).data()
            : undefined;
        const fresh = planConversationMirror(data, contact);
        if (!fresh.patch) return false;
        tx.update(row.ref, { ...fresh.patch });
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
    JSON.stringify(await backfillConversationOwnerEmail(getFirestore(), args))
  );
}
