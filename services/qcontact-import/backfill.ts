/**
 * One-off backfill: creates the missing LeadStack deal for a "seen" QContact
 * case that predates deal creation (see README's "Forward-only, by design" —
 * these cases were upserted as contacts before QCONTACT_DEAL_PIPELINE_ID
 * existed, so `state.deals` has no entry for them and stage-sync has been
 * silently skipping them ever since, counted under `stageUnmapped`).
 *
 * This is NOT the recurring stage-sync path. It never touches
 * POST /api/v1/contacts/upsert (see deals.ts / stage-sync.ts's own comments
 * on why re-deriving a case's contact was rejected: it would re-fire the
 * enrolment-gated upsert and re-write a manually-edited name/address). The
 * only write here is the same idempotency-keyed `POST /api/v1/deals` the
 * normal importer already uses via `leadstackDealEnsurer` (deals.ts) — that
 * call has no enrolment gate at all, so it's the no-enrol path.
 *
 * To call it we still need each case's LeadStack contact id, which the
 * state file never recorded for pre-deal cases. Since the public API has no
 * "find contact by custom field" endpoint, `leadstackContactFinder` below
 * paginates GET /api/v1/contacts (a plain read, no triggers) looking for
 * `custom_fields.qcontact_case_id` — built once per run, not per case.
 *
 * The deal is created directly at the stage matching the case's CURRENT
 * QContact status (`statusToStageId`, reused from stage-sync.ts) by
 * overriding `QCONTACT_DEAL_STAGE` per case — an unrecognised status is
 * reported and skipped, never guessed. A case no longer present in the
 * current view has no known current status and is reported, not guessed
 * either.
 *
 * Run with Node 22 from the repo root:
 *   node --env-file=.env.local --experimental-strip-types services/qcontact-import/backfill.ts [--apply]
 *
 * Dry-run (default): reads QContact + LeadStack and prints what it would
 * create, writes nothing. `--apply` creates the deals and updates the same
 * state file the normal importer uses (only the `deals` map — exactly what
 * a normal run records when `ensureDeal` creates or finds a deal).
 *
 * Takes the same run lock as run.ts (`${QCONTACT_IMPORT_STATE}.lock`) so it
 * can never run concurrently with a timer-triggered import.
 */
import { QContactClient, type CaseRow } from "./qcontact.ts";
import { statusToStageId } from "./stage-sync.ts";
import { leadstackDealEnsurer, type DealEnv, type DealResult } from "./deals.ts";
import { leadstackFetch } from "./leadstack-fetch.ts";
import {
  acquireLock,
  describeLockRefusal,
  loadState,
  readEnv,
  saveState,
  type Log,
} from "./run.ts";

export type CaseContactMatch = {
  contactId: string;
  /** Never logged — only used in the deal title. */
  name: string;
  caseRef: string | undefined;
};

/** Reads only; never calls contacts/upsert. Looked up once per run, not per case. */
export type ContactFinder = (caseIds: string[]) => Promise<Map<string, CaseContactMatch>>;

type ContactsListResponse = {
  data: Array<{ id: string; name?: unknown; custom_fields: Record<string, unknown> | null }>;
  has_more: boolean;
};

/**
 * Paginates GET /api/v1/contacts looking for `custom_fields.qcontact_case_id`
 * among `caseIds`. A plain read — no enrolment gate, no trigger of any kind.
 * Stops as soon as every id has been found, or the list runs out.
 */
export function leadstackContactFinder(
  env: { LEADSTACK_API_URL: string; LEADSTACK_API_KEY: string },
  fetchImpl: typeof fetch = fetch,
): ContactFinder {
  const lsFetch = leadstackFetch(fetchImpl);
  return async (caseIds) => {
    const remaining = new Set(caseIds);
    const found = new Map<string, CaseContactMatch>();
    let after: string | undefined;
    while (remaining.size > 0) {
      const url = new URL(`${env.LEADSTACK_API_URL}/api/v1/contacts`);
      url.searchParams.set("limit", "100");
      if (after) url.searchParams.set("starting_after", after);
      const res = await lsFetch(url.toString(), {
        headers: { Authorization: `Bearer ${env.LEADSTACK_API_KEY}` },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} listing contacts: ${(await res.text()).slice(0, 300)}`);
      }
      const page = (await res.json()) as ContactsListResponse;
      for (const c of page.data) {
        const caseId = c.custom_fields?.qcontact_case_id;
        if (typeof caseId === "string" && remaining.has(caseId)) {
          const ref = c.custom_fields?.qcontact_case_ref;
          found.set(caseId, {
            contactId: c.id,
            name: typeof c.name === "string" ? c.name : "",
            caseRef: typeof ref === "string" ? ref : undefined,
          });
          remaining.delete(caseId);
        }
      }
      if (!page.has_more || page.data.length === 0) break;
      after = page.data[page.data.length - 1]?.id;
    }
    return found;
  };
}

export type BackfillSummary = {
  mode: "dry-run" | "apply";
  /** state.seen with no recorded state.deals entry. */
  candidates: number;
  /** A candidate no longer in the current view — current status unknown, skipped. */
  notInView: number;
  /** A candidate's current status has no entry in STATUS_TO_STAGE_ID — skipped, never guessed. */
  unmappedStatus: number;
  /** No LeadStack contact found with this case id in custom_fields — skipped. */
  contactNotFound: number;
  /** Deal created (or already existed) and recorded in state.deals. */
  created: number;
  /** The deal-create call itself failed; retried by re-running this script. */
  failed: number;
};

export async function runBackfill(opts: {
  qc: Pick<QContactClient, "listView">;
  view: string;
  statePath: string;
  findContacts: ContactFinder;
  ensureDeal: (input: { contactId: string; caseId: number; title: string; stage: string }) => Promise<DealResult>;
  dryRun: boolean;
  log: Log;
}): Promise<BackfillSummary> {
  const { qc, view, statePath, findContacts, ensureDeal, dryRun, log } = opts;
  const state = await loadState(statePath);
  if (!state) {
    throw new Error(`No state file at ${statePath} — run the normal importer at least once first.`);
  }

  const rows = await qc.listView(view);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const deals: Record<string, string> = { ...state.deals };

  const candidateIds = state.seen.filter((id) => !deals[String(id)]);
  const summary: BackfillSummary = {
    mode: dryRun ? "dry-run" : "apply",
    candidates: candidateIds.length,
    notInView: 0,
    unmappedStatus: 0,
    contactNotFound: 0,
    created: 0,
    failed: 0,
  };

  const mapped: Array<{ row: CaseRow; stage: string }> = [];
  for (const id of candidateIds) {
    const row = byId.get(id);
    if (!row) {
      summary.notInView++;
      log(`case ${id} not in current view "${view}"; current status unknown, skipping`);
      continue;
    }
    const stage = statusToStageId(row.status);
    if (!stage) {
      summary.unmappedStatus++;
      log(`unmapped status for case ${row.id} (${row.label}): ${row.status ?? "null"}`);
      continue;
    }
    mapped.push({ row, stage });
  }

  if (mapped.length === 0) return summary;

  const contacts = await findContacts(mapped.map((m) => String(m.row.id)));

  for (const { row, stage } of mapped) {
    const match = contacts.get(String(row.id));
    if (!match) {
      summary.contactNotFound++;
      log(`no LeadStack contact found for case ${row.id} (${row.label})`);
      continue;
    }
    if (dryRun) {
      log(`would create deal for case ${row.id} (${row.label}) at stage ${stage}`);
      summary.created++;
      continue;
    }
    const caseRef = match.caseRef ?? String(row.id);
    const result = await ensureDeal({
      contactId: match.contactId,
      caseId: row.id,
      title: `Install request — ${match.name} (${caseRef})`,
      stage,
    });
    if (!result.ok) {
      summary.failed++;
      log(`FAILED deal ${row.id} (${row.label}): ${result.error}`);
      continue;
    }
    deals[String(row.id)] = result.dealId;
    summary.created++;
    log(`created deal ${row.id} (${row.label}) at stage ${stage}`);
    // Recorded exactly like a normal run: only the deals map. The next
    // scheduled stage-sync will pick up dealStages for this case on its own.
    await saveState(statePath, { seen: state.seen, deals, dealStages: state.dealStages, updatedAt: "" });
  }

  return summary;
}

async function main(): Promise<void> {
  const env = readEnv(process.env);
  if (!env.QCONTACT_DEAL_PIPELINE_ID) {
    process.stderr.write("QCONTACT_DEAL_PIPELINE_ID must be set to backfill deals.\n");
    process.exitCode = 1;
    return;
  }
  const dryRun = !process.argv.includes("--apply");
  const lockPath = `${env.QCONTACT_IMPORT_STATE}.lock`;
  const lock = await acquireLock(lockPath);
  if (!lock.ok) {
    const { stream, message, exitCode } = describeLockRefusal(lockPath, lock);
    process[stream].write(message);
    process.exitCode = exitCode;
    return;
  }
  try {
    const qc = new QContactClient({
      baseUrl: env.QCONTACT_BASE_URL,
      email: env.QCONTACT_IMPORT_EMAIL,
      password: env.QCONTACT_IMPORT_PASSWORD,
    });
    const dealEnv: DealEnv = {
      LEADSTACK_API_URL: env.LEADSTACK_API_URL,
      LEADSTACK_API_KEY: env.LEADSTACK_API_KEY,
      QCONTACT_DEAL_PIPELINE_ID: env.QCONTACT_DEAL_PIPELINE_ID,
      QCONTACT_DEAL_STAGE: env.QCONTACT_DEAL_STAGE,
      QCONTACT_DEAL_OWNER_UID: env.QCONTACT_DEAL_OWNER_UID,
    };
    const summary = await runBackfill({
      qc,
      view: env.QCONTACT_IMPORT_VIEW,
      statePath: env.QCONTACT_IMPORT_STATE,
      findContacts: leadstackContactFinder(env),
      ensureDeal: ({ contactId, caseId, title, stage }) =>
        leadstackDealEnsurer({ ...dealEnv, QCONTACT_DEAL_STAGE: stage })({ contactId, caseId, title }),
      dryRun,
      log: (l) => process.stdout.write(`${l}\n`),
    });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (summary.failed > 0) process.exitCode = 1;
  } finally {
    await lock.release();
  }
}

if (process.argv[1]?.endsWith("backfill.ts")) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
