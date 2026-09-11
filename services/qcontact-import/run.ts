/**
 * Velocity new-installation importer: QContact Case view → LeadStack contacts.
 *
 * Run with Node 22 from the repo root:
 *   node --env-file=.env.local --experimental-strip-types services/qcontact-import/run.ts [--dry-run]
 *
 * Forward-only. The state file holds every case id already handled. When it
 * does not exist yet, the run SEEDS it with every case currently in the view
 * and sends nothing — the backlog is a separate, approved campaign, never an
 * accidental side effect of the first run. After that, each run upserts only
 * the cases it has not seen, and a case is marked seen only after LeadStack
 * accepted it, so a failed upsert is retried next run.
 */
import { readFile, writeFile, rename } from "node:fs/promises";
import { QContactClient, type CaseRow } from "./qcontact.ts";
import { mapCase, type UpsertBody } from "./map.ts";

export type Env = {
  QCONTACT_BASE_URL: string;
  QCONTACT_IMPORT_EMAIL: string;
  QCONTACT_IMPORT_PASSWORD: string;
  QCONTACT_IMPORT_VIEW: string;
  LEADSTACK_API_URL: string;
  LEADSTACK_API_KEY: string;
  QCONTACT_IMPORT_STATE: string;
};

export type State = { seen: number[]; updatedAt: string };

export type Summary = {
  mode: "seed" | "import" | "dry-run";
  inView: number;
  fresh: number;
  sent: number;
  skipped: Record<string, number>;
  failed: number;
};

export type Log = (line: string) => void;

export function readEnv(env: NodeJS.ProcessEnv): Env {
  const need = (k: keyof Env): string => {
    const v = env[k];
    if (!v) throw new Error(`Missing env ${k}`);
    return v;
  };
  return {
    QCONTACT_BASE_URL: env.QCONTACT_BASE_URL ?? "https://fibertime.qcontact.com",
    QCONTACT_IMPORT_EMAIL: need("QCONTACT_IMPORT_EMAIL"),
    QCONTACT_IMPORT_PASSWORD: need("QCONTACT_IMPORT_PASSWORD"),
    QCONTACT_IMPORT_VIEW: env.QCONTACT_IMPORT_VIEW ?? "my-bucket-growth-view",
    LEADSTACK_API_URL: need("LEADSTACK_API_URL"),
    LEADSTACK_API_KEY: need("LEADSTACK_API_KEY"),
    QCONTACT_IMPORT_STATE: env.QCONTACT_IMPORT_STATE ?? ".qcontact-import-state.json",
  };
}

export async function loadState(path: string): Promise<State | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<State>;
    if (!Array.isArray(parsed.seen)) throw new Error(`State file ${path} has no seen[]`);
    return { seen: parsed.seen, updatedAt: parsed.updatedAt ?? "" };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function saveState(path: string, state: State): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }));
  await rename(tmp, path);
}

export type Upserter = (body: UpsertBody) => Promise<{ ok: true } | { ok: false; error: string }>;

export function leadstackUpserter(env: Env, fetchImpl: typeof fetch = fetch): Upserter {
  return async (body) => {
    const res = await fetchImpl(`${env.LEADSTACK_API_URL}/api/v1/contacts/upsert`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.LEADSTACK_API_KEY}`,
        "Content-Type": "application/json",
        // One case = one request; a retried run replays, never duplicates.
        "Idempotency-Key": `qcontact-case-${body.custom_fields.qcontact_case_id}`,
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: `HTTP ${res.status} ${(await res.text()).slice(0, 300)}` };
  };
}

export async function runImport(opts: {
  qc: Pick<QContactClient, "listView" | "getCase" | "getContact">;
  view: string;
  statePath: string;
  upsert: Upserter;
  dryRun: boolean;
  log: Log;
}): Promise<Summary> {
  const { qc, view, statePath, upsert, dryRun, log } = opts;
  const rows: CaseRow[] = await qc.listView(view);
  const state = await loadState(statePath);

  if (state === null) {
    if (!dryRun) await saveState(statePath, { seen: rows.map((r) => r.id), updatedAt: "" });
    log(`seed: recorded ${rows.length} existing cases as seen; nothing sent`);
    return { mode: "seed", inView: rows.length, fresh: 0, sent: 0, skipped: {}, failed: 0 };
  }

  const seen = new Set(state.seen);
  const fresh = rows.filter((r) => !seen.has(r.id)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const summary: Summary = {
    mode: dryRun ? "dry-run" : "import",
    inView: rows.length, fresh: fresh.length, sent: 0, skipped: {}, failed: 0,
  };

  for (const row of fresh) {
    const detail = await qc.getCase(row.id);
    const contact = detail.lookup_contact_id ? await qc.getContact(detail.lookup_contact_id) : null;
    const mapped = mapCase(detail, contact);
    if (!mapped.ok) {
      summary.skipped[mapped.reason] = (summary.skipped[mapped.reason] ?? 0) + 1;
      log(`skip ${row.id} (${row.label}): ${mapped.reason}`);
      // Nothing to retry: the case has no usable contact. Mark it seen.
      if (!dryRun) { seen.add(row.id); await saveState(statePath, { seen: [...seen], updatedAt: "" }); }
      continue;
    }
    if (dryRun) {
      // No phone in the log: stdout ends up in cron mail and journal files.
      log(`would send ${row.id} (${row.label})`);
      summary.sent++;
      continue;
    }
    const result = await upsert(mapped.body);
    if (!result.ok) {
      summary.failed++;
      log(`FAILED ${row.id} (${row.label}): ${result.error}`);
      continue;
    }
    summary.sent++;
    seen.add(row.id);
    await saveState(statePath, { seen: [...seen], updatedAt: "" });
    log(`sent ${row.id} (${row.label})`);
  }
  return summary;
}

async function main(): Promise<void> {
  const env = readEnv(process.env);
  const dryRun = process.argv.includes("--dry-run");
  const qc = new QContactClient({
    baseUrl: env.QCONTACT_BASE_URL,
    email: env.QCONTACT_IMPORT_EMAIL,
    password: env.QCONTACT_IMPORT_PASSWORD,
  });
  const summary = await runImport({
    qc, view: env.QCONTACT_IMPORT_VIEW, statePath: env.QCONTACT_IMPORT_STATE,
    upsert: leadstackUpserter(env), dryRun,
    log: (l) => process.stdout.write(`${l}\n`),
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.failed > 0) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("run.ts")) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
