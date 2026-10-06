/**
 * List every workflow run that has not finished (status `running` or
 * `waiting`) for the given workflows in one sub-account. Read-only.
 *
 * Written for a channel cutover: before a workflow is set inactive, every run
 * still in flight must be found and either ended or moved, and on rollback a
 * run that already messaged its contact must not be re-enrolled (enrolment
 * always starts at the first step, so it would repeat the message).
 *
 * Run with Node 22:
 *   node --env-file=.env.local --experimental-strip-types \
 *     scripts/list-open-workflow-runs.ts --project <firebase-project-id> \
 *     --sub-account <id> --workflow <id> [--workflow <id> ...]
 *
 * Prints one JSON line per open run, then a summary line with the count per
 * workflow. `--project` must match the credential's project, so a wrong env
 * file can't read the wrong database. Test runs are listed and flagged.
 */
import { pathToFileURL } from "node:url";
import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

/** Mirrors AT_MOST_ONCE_NODES in src/lib/workflows/engine.ts; a test keeps them equal. */
export const MESSAGING_STEP_TYPES: ReadonlySet<string> = new Set([
  "send_email",
  "send_sms",
  "whatsapp_template",
  "send_whatsapp",
]);

export interface ListArgs {
  projectId: string;
  subAccountId: string;
  workflowIds: string[];
}

export function parseArgs(argv: string[]): ListArgs {
  const values = (flag: string) =>
    argv.flatMap((a, i) => (a === flag ? [argv[i + 1] ?? ""] : []));
  const one = (flag: string) => {
    const v = values(flag);
    if (v.length !== 1 || !v[0] || v[0].startsWith("--"))
      throw new Error(`${flag} <id> is required once`);
    return v[0];
  };
  const workflowIds = values("--workflow");
  if (workflowIds.length === 0 || workflowIds.some((w) => !w || w.startsWith("--")))
    throw new Error("--workflow <id> is required (repeat it for several)");
  return { projectId: one("--project"), subAccountId: one("--sub-account"), workflowIds };
}

export interface OpenRun {
  runId: string;
  workflowId: string;
  contactId: string;
  status: "running" | "waiting";
  test: boolean;
  currentNodeId: string | null;
  waitingUntil: string | null;
  enrolledAt: string | null;
  /**
   * True unless every messaging step was skipped or deferred: a step that sent
   * ("ok", "sent:…"), an ambiguous send the run continued past ("error:…"),
   * and any step claim (sending, or failed mid-send) all count. Errs towards
   * true, because a false here lets a rollback message the contact twice.
   */
  messaged: boolean;
}

type Ts = { toDate(): Date } | null | undefined;
const iso = (t: unknown): string | null =>
  t && typeof (t as { toDate?: unknown }).toDate === "function"
    ? (t as Exclude<Ts, null | undefined>).toDate().toISOString()
    : null;

/** The open-run view of one run doc, or null when it is finished or belongs elsewhere. */
export function toOpenRun(
  runId: string,
  d: Record<string, unknown>,
  subAccountId: string
): OpenRun | null {
  if (d.subAccountId !== subAccountId) return null;
  if (d.status !== "running" && d.status !== "waiting") return null;
  const history = Array.isArray(d.history) ? (d.history as { type?: unknown; result?: unknown }[]) : [];
  const sent = history.some(
    (h) =>
      typeof h.type === "string" &&
      MESSAGING_STEP_TYPES.has(h.type) &&
      !(typeof h.result === "string" && /^(skipped|deferred):/.test(h.result))
  );
  const claim = d.stepClaim as { state?: unknown } | null | undefined;
  const waiting = d.waiting as { until?: unknown } | null | undefined;
  const context = d.context as { test?: unknown } | null | undefined;
  return {
    runId,
    workflowId: String(d.workflowId),
    contactId: String(d.contactId),
    status: d.status as OpenRun["status"],
    test: context?.test === true,
    currentNodeId: typeof d.currentNodeId === "string" ? d.currentNodeId : null,
    waitingUntil: iso(waiting?.until),
    enrolledAt: iso(d.enrolledAt),
    messaged: sent || (claim != null && claim.state !== undefined),
  };
}

export async function listOpenRuns(db: Firestore, args: ListArgs): Promise<OpenRun[]> {
  const out: OpenRun[] = [];
  for (const workflowId of args.workflowIds) {
    const snap = await db.collection("workflowRuns").where("workflowId", "==", workflowId).get();
    for (const doc of snap.docs) {
      const run = toOpenRun(doc.id, doc.data(), args.subAccountId);
      if (run) out.push(run);
    }
  }
  return out.sort((a, b) => (a.enrolledAt ?? "").localeCompare(b.enrolledAt ?? ""));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
  const runs = await listOpenRuns(getFirestore(), args);
  for (const r of runs) console.log(JSON.stringify(r));
  const perWorkflow = Object.fromEntries(
    args.workflowIds.map((w) => [w, runs.filter((r) => r.workflowId === w).length])
  );
  console.log(JSON.stringify({ open: runs.length, perWorkflow }));
}
