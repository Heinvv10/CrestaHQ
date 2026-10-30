/**
 * Move integration credentials off the member-readable `subAccounts/{id}` doc
 * into the server-only `subAccounts/{id}/private/*` docs (see
 * src/types/sub-account-secrets.ts):
 *
 *   twilioConfig.authToken        → private/twilioCredentials.authToken
 *   metaConfig.pageAccessToken    → private/metaCredentials.pageAccessToken
 *   ghlImportConfig.token         → private/ghlImportCredentials.token
 *
 * Run with Node 22 AFTER the code that reads the private docs is deployed:
 *   node --env-file=.env.local --experimental-strip-types \
 *     scripts/migrate-private-credentials.ts --project <firebase-project-id> [--apply]
 *
 * Dry-run by default: reads only and prints counts. `--apply` handles each
 * sub-account in a transaction that re-reads both docs, copies the legacy
 * value into the private doc (unless the private doc already holds one — a
 * re-connect since deploy wrote it there, and it is newer), then deletes the
 * legacy field. Idempotent: a second run finds nothing to move. A dry-run
 * after `--apply` reporting `legacy: 0` for every kind is the verification.
 *
 * `--project` must match the credential's project, so the script cannot hit
 * a project the operator did not name. Prints counts only — never a value.
 */
import { pathToFileURL } from "node:url";
import { cert, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore, type Firestore } from "firebase-admin/firestore";
import {
  SUB_ACCOUNT_SECRETS,
  subAccountSecretPath,
  type SubAccountSecretKind,
} from "../src/types/sub-account-secrets.ts";

const KINDS = Object.keys(SUB_ACCOUNT_SECRETS) as SubAccountSecretKind[];

export interface MigrateArgs {
  projectId: string;
  apply: boolean;
}

export function parseArgs(argv: string[]): MigrateArgs {
  const i = argv.indexOf("--project");
  const projectId = i >= 0 ? (argv[i + 1] ?? "") : "";
  if (!projectId || projectId.startsWith("--"))
    throw new Error("--project <firebase-project-id> is required");
  return { projectId, apply: argv.includes("--apply") };
}

/**
 * Against real Firestore the named project must be the one the credential is
 * for; the emulator (FIRESTORE_EMULATOR_HOST) has no credential to compare.
 */
export function assertProjectMatches(
  args: MigrateArgs,
  env: Record<string, string | undefined>,
): void {
  if (env.FIRESTORE_EMULATOR_HOST) return;
  if (env.FIREBASE_ADMIN_PROJECT_ID !== args.projectId) {
    throw new Error(`--project ${args.projectId} does not match FIREBASE_ADMIN_PROJECT_ID — refusing`);
  }
}

interface KindCounts {
  /** Sub-accounts still carrying the secret on the parent doc. */
  legacy: number;
  /** Of those, copied into a private doc that had no value. */
  copied: number;
  /** Of those, the private doc already held a value; left as is. */
  privateKept: number;
  /** Legacy fields deleted from the parent doc (apply only). */
  deleted: number;
}

export interface MigrateResult {
  apply: boolean;
  scanned: number;
  kinds: Record<SubAccountSecretKind, KindCounts>;
}

const secretOf = (data: Record<string, unknown> | undefined, kind: SubAccountSecretKind) => {
  const { parent, field } = SUB_ACCOUNT_SECRETS[kind];
  const v = (data?.[parent] as Record<string, unknown> | null | undefined)?.[field];
  return typeof v === "string" && v ? v : null;
};

export async function migratePrivateCredentials(
  db: Firestore,
  args: MigrateArgs,
): Promise<MigrateResult> {
  const kinds = Object.fromEntries(
    KINDS.map((k) => [k, { legacy: 0, copied: 0, privateKept: 0, deleted: 0 }]),
  ) as Record<SubAccountSecretKind, KindCounts>;
  const r: MigrateResult = { apply: args.apply, scanned: 0, kinds };

  // One unpaginated scan: sub-accounts number in the tens, and every write
  // re-reads its doc inside a transaction anyway.
  const all = await db.collection("subAccounts").get();
  for (const row of all.docs) {
    r.scanned++;
    for (const kind of KINDS) {
      if (!secretOf(row.data(), kind)) continue;
      const privRef = db.doc(subAccountSecretPath(row.id, kind));
      const { parent, field } = SUB_ACCOUNT_SECRETS[kind];
      // Plan and write from one consistent read — a concurrent re-connect
      // between the scan and here is re-planned, not overwritten.
      const outcome = await db.runTransaction(async (tx) => {
        const [cur, priv] = await tx.getAll(row.ref, privRef);
        const legacy = secretOf(cur.data(), kind);
        if (!legacy) return null;
        const held = priv.data()?.[field];
        const copy = !(typeof held === "string" && held);
        if (args.apply) {
          if (copy) tx.set(privRef, { [field]: legacy }, { merge: true });
          tx.update(row.ref, {
            [`${parent}.${field}`]: FieldValue.delete(),
            // Twilio's "configured" check reads this marker instead of the token.
            ...(kind === "twilio" ? { "twilioConfig.authTokenSet": true } : {}),
          });
        }
        return copy ? "copied" : "privateKept";
      });
      if (!outcome) continue;
      kinds[kind].legacy++;
      kinds[kind][outcome]++;
      if (args.apply) kinds[kind].deleted++;
    }
  }
  return r;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  assertProjectMatches(args, process.env);
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    initializeApp({ projectId: args.projectId });
  } else {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
        clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      }),
    });
  }
  console.log(JSON.stringify(await migratePrivateCredentials(getFirestore(), args)));
}
