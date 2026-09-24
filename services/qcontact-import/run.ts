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
 *
 * When QCONTACT_DEAL_PIPELINE_ID is set, a case is also marked seen only
 * once it has an open deal in that pipeline (see deals.ts) — a failed deal
 * step retries next run too, same as a failed upsert.
 */
import { readFile, writeFile, rename, unlink, open, stat } from "node:fs/promises";
import { QContactClient, type CaseRow, type LocationDetail } from "./qcontact.ts";
import { gpsFromLocationFields, locationPinId, mapCase, type UpsertBody } from "./map.ts";
import { leadstackDealEnsurer, type DealEnsurer } from "./deals.ts";
import { leadstackStageSyncer, statusToStageId, type StageSyncer } from "./stage-sync.ts";
import { dedupedIdempotencyKey } from "./idempotency-key.ts";
import { leadstackFetch } from "./leadstack-fetch.ts";

export type Env = {
  QCONTACT_BASE_URL: string;
  QCONTACT_IMPORT_EMAIL: string;
  QCONTACT_IMPORT_PASSWORD: string;
  QCONTACT_IMPORT_VIEW: string;
  LEADSTACK_API_URL: string;
  LEADSTACK_API_KEY: string;
  QCONTACT_IMPORT_STATE: string;
  /** Unset = no deal is created (behaviour unchanged from before this existed). */
  QCONTACT_DEAL_PIPELINE_ID: string | undefined;
  QCONTACT_DEAL_STAGE: string;
  /** Sent as `assigned_to_uid`; must be an active sub-account member's uid or the deal create 400s. */
  QCONTACT_DEAL_OWNER_UID: string | undefined;
  /** "1" (or any value other than unset/"0") turns on deal-stage syncing (see stage-sync.ts). Default OFF. */
  QCONTACT_SYNC_STAGES: string;
};

export type State = {
  seen: number[];
  /** Case id (as a string key) → LeadStack deal id, recorded when the deal is created/found. */
  deals: Record<string, string>;
  /** Case id → the stage id we last set on that deal, so stage-sync knows "differs" without a GET. */
  dealStages: Record<string, string>;
  updatedAt: string;
};

export type Summary = {
  mode: "seed" | "import" | "dry-run";
  inView: number;
  fresh: number;
  sent: number;
  skipped: Record<string, number>;
  failed: number;
  stageSynced: number;
  stageUnchanged: number;
  /** In-view cases with no recorded deal id — never re-derived, just counted. */
  stageUnmapped: number;
  /** Distinct location pins resolved to usable in-bounds coordinates. */
  locationsResolved: number;
  /** Distinct location pins resolved but with no usable in-bounds coordinates. */
  locationsSkippedInvalid: number;
  /** Distinct location pins whose lookup failed (404/500/etc). */
  locationsLookupFailed: number;
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
    QCONTACT_DEAL_PIPELINE_ID: env.QCONTACT_DEAL_PIPELINE_ID || undefined,
    QCONTACT_DEAL_STAGE: env.QCONTACT_DEAL_STAGE ?? "new_request",
    QCONTACT_DEAL_OWNER_UID: env.QCONTACT_DEAL_OWNER_UID || undefined,
    QCONTACT_SYNC_STAGES: env.QCONTACT_SYNC_STAGES ?? "0",
  };
}

export async function loadState(path: string): Promise<State | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<State>;
    if (!Array.isArray(parsed.seen)) throw new Error(`State file ${path} has no seen[]`);
    // Older state files predate `deals`/`dealStages` — treat a missing map as empty.
    return {
      seen: parsed.seen,
      deals: parsed.deals && typeof parsed.deals === "object" ? parsed.deals : {},
      dealStages: parsed.dealStages && typeof parsed.dealStages === "object" ? parsed.dealStages : {},
      updatedAt: parsed.updatedAt ?? "",
    };
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

/** See "Run lock" in README.md for why this exists and how staleness is decided. */
export const LOCK_STALE_AGE_MS = 60 * 60 * 1000; // 1h

export type AcquireLockResult =
  | { ok: true; release: () => Promise<void> }
  /** `stale: true` = the lock looks stuck (older than LOCK_STALE_AGE_MS) but its PID still
   *  reads as alive (PID reuse after a reboot, or no permission to signal it) — refused rather
   *  than auto-reclaimed, since that PID may genuinely belong to something else now. The
   *  caller should log this loudly and fail non-zero so it's visible in the systemd journal,
   *  instead of the quiet, expected "another run is active" case. */
  | { ok: false; stale: boolean; ageMs: number };

/**
 * Exclusive run lock at `${statePath}.lock`, written via O_EXCL so two
 * concurrent invocations can't both proceed and stomp each other's
 * full-state overwrite. See README.md's "Run lock" section for why this
 * exists (the timer can't overlap the same systemd unit; a manual run can)
 * and how a leftover lock is detected.
 */
export async function acquireLock(lockPath: string, retried = false): Promise<AcquireLockResult> {
  try {
    const handle = await open(lockPath, "wx");
    try {
      await handle.writeFile(String(process.pid));
    } finally {
      await handle.close();
    }
    // The create (open wx) and the write aren't one atomic step: another run
    // can see this file between them, judge it stale off its (momentarily
    // empty) content, delete it, and recreate it with its own pid. Re-read
    // before trusting we hold it; if it's not our pid any more, back off
    // rather than proceeding as if we'd acquired it.
    const holder = await readFile(lockPath, "utf8").catch(() => "");
    if (holder !== String(process.pid)) return { ok: false, stale: false, ageMs: 0 };
    return { ok: true, release: () => unlink(lockPath).catch((err) => logLockError(`failed to release qcontact-import lock ${lockPath}: ${err instanceof Error ? err.message : String(err)}`)) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const st = await stat(lockPath).catch(() => null);
    const ageMs = st ? Date.now() - st.mtimeMs : 0;
    const pid = await readPid(lockPath);
    const alive = pid !== null && isProcessAlive(pid);
    if (alive) {
      // A validly-alive PID older than the stale cap is suspicious (reused
      // after a reboot, or belongs to something we can't signal) rather than
      // trusted outright — refuse instead of guessing, and flag it as such.
      return { ok: false, stale: ageMs > LOCK_STALE_AGE_MS, ageMs };
    }
    if (retried) return { ok: false, stale: ageMs > LOCK_STALE_AGE_MS, ageMs }; // still contended right after clearing a stale lock
    // No pid, an invalid pid, or a dead one — genuinely stale. Clear it and try once more.
    await unlink(lockPath).catch(() => {});
    return acquireLock(lockPath, true);
  }
}

async function readPid(lockPath: string): Promise<number | null> {
  let raw: string;
  try {
    raw = (await readFile(lockPath, "utf8")).trim();
  } catch {
    return null;
  }
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function logLockError(line: string): void {
  process.stderr.write(`${line}\n`);
}

export type Upserter = (
  body: UpsertBody,
) => Promise<{ ok: true; contactId: string } | { ok: false; error: string }>;

export function leadstackUpserter(env: Env, fetchImpl: typeof fetch = fetch): Upserter {
  const lsFetch = leadstackFetch(fetchImpl);
  return async (body) => {
    const res = await lsFetch(`${env.LEADSTACK_API_URL}/api/v1/contacts/upsert`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.LEADSTACK_API_KEY}`,
        "Content-Type": "application/json",
        // One case = one request; a retried run replays, never duplicates. The
        // body-fingerprint suffix means a changed body (e.g. the contact's
        // name) doesn't get stuck 409ing against a stale cached response.
        "Idempotency-Key": dedupedIdempotencyKey(`qcontact-case-${body.custom_fields.qcontact_case_id}`, body),
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        return { ok: false, error: "upsert 2xx without contact.id" };
      }
      const contactId = (data as { contact?: { id?: unknown } } | null)?.contact?.id;
      if (typeof contactId !== "string" || contactId.length === 0) {
        return { ok: false, error: "upsert 2xx without contact.id" };
      }
      return { ok: true, contactId };
    }
    return { ok: false, error: `HTTP ${res.status} ${(await res.text()).slice(0, 300)}` };
  };
}

export async function runImport(opts: {
  qc: Pick<QContactClient, "listView" | "getCase" | "getContact">;
  view: string;
  statePath: string;
  upsert: Upserter;
  /** Unset = no deal calls at all (matches pre-existing behaviour). */
  ensureDeal?: DealEnsurer;
  /** Unset = no stage-sync calls at all (matches pre-existing behaviour). */
  syncStage?: StageSyncer;
  /** Unset = a case's location pin is never resolved, so no coordinates are ever written. */
  getLocation?: (id: number) => Promise<LocationDetail>;
  dryRun: boolean;
  log: Log;
}): Promise<Summary> {
  const { qc, view, statePath, upsert, ensureDeal, syncStage, getLocation, dryRun, log } = opts;
  const rows: CaseRow[] = await qc.listView(view);
  const state = await loadState(statePath);

  if (state === null) {
    if (!dryRun) await saveState(statePath, { seen: rows.map((r) => r.id), deals: {}, dealStages: {}, updatedAt: "" });
    log(`seed: recorded ${rows.length} existing cases as seen; nothing sent`);
    return {
      mode: "seed", inView: rows.length, fresh: 0, sent: 0, skipped: {}, failed: 0,
      stageSynced: 0, stageUnchanged: 0, stageUnmapped: 0,
      locationsResolved: 0, locationsSkippedInvalid: 0, locationsLookupFailed: 0,
    };
  }

  const seen = new Set(state.seen);
  const deals: Record<string, string> = { ...state.deals };
  const dealStages: Record<string, string> = { ...state.dealStages };
  const fresh = rows.filter((r) => !seen.has(r.id)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const summary: Summary = {
    mode: dryRun ? "dry-run" : "import",
    inView: rows.length, fresh: fresh.length, sent: 0, skipped: {}, failed: 0,
    stageSynced: 0, stageUnchanged: 0, stageUnmapped: 0,
    locationsResolved: 0, locationsSkippedInvalid: 0, locationsLookupFailed: 0,
  };
  // Pin id → resolved gps ("<lat>,<lng>") or null (invalid/lookup failed) —
  // resolved at most once per pin per run, whether or not multiple fresh
  // cases share it.
  const locationCache = new Map<string, string | null>();

  for (const row of fresh) {
    const detail = await qc.getCase(row.id);
    const contact = detail.lookup_contact_id ? await qc.getContact(detail.lookup_contact_id) : null;

    let gps: string | undefined;
    const pin = locationPinId(detail);
    if (pin && getLocation) {
      if (locationCache.has(pin)) {
        gps = locationCache.get(pin) ?? undefined;
      } else {
        const pinId = Number(pin);
        let resolved: string | undefined;
        if (Number.isFinite(pinId)) {
          try {
            const location: LocationDetail = await getLocation(pinId);
            resolved = gpsFromLocationFields(location.fields);
            if (resolved) summary.locationsResolved++;
            else summary.locationsSkippedInvalid++;
          } catch (err) {
            summary.locationsLookupFailed++;
            log(`location lookup failed for pin ${pin} on case ${row.id} (${row.label}): ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          summary.locationsLookupFailed++;
          log(`location lookup failed for pin ${pin} on case ${row.id} (${row.label}): not a valid id`);
        }
        locationCache.set(pin, resolved ?? null);
        gps = resolved;
      }
    }

    const mapped = mapCase(detail, contact, gps);
    if (!mapped.ok) {
      summary.skipped[mapped.reason] = (summary.skipped[mapped.reason] ?? 0) + 1;
      log(`skip ${row.id} (${row.label}): ${mapped.reason}`);
      // Nothing to retry: the case has no usable contact. Mark it seen.
      if (!dryRun) { seen.add(row.id); await saveState(statePath, { seen: [...seen], deals, dealStages, updatedAt: "" }); }
      continue;
    }
    if (dryRun) {
      // No phone in the log: stdout ends up in cron mail and journal files.
      log(`would send ${row.id} (${row.label})`);
      if (ensureDeal) log(`would create deal ${row.id} (${row.label})`);
      summary.sent++;
      continue;
    }
    const result = await upsert(mapped.body);
    if (!result.ok) {
      summary.failed++;
      log(`FAILED ${row.id} (${row.label}): ${result.error}`);
      continue;
    }

    if (ensureDeal) {
      const caseRef = mapped.body.custom_fields.qcontact_case_ref ?? String(row.id);
      const dealResult = await ensureDeal({
        contactId: result.contactId,
        caseId: row.id,
        title: `Install request — ${mapped.body.name} (${caseRef})`,
      });
      if (!dealResult.ok) {
        // Upsert already succeeded (and is idempotent), so only the deal step retries next run.
        summary.failed++;
        log(`FAILED deal ${row.id} (${row.label}): ${dealResult.error}`);
        continue;
      }
      // Recorded even when the deal already existed (e.g. a retry after a
      // prior deal-step failure) — stage-sync below needs this mapping.
      deals[String(row.id)] = dealResult.dealId;
    }

    summary.sent++;
    seen.add(row.id);
    await saveState(statePath, { seen: [...seen], deals, dealStages, updatedAt: "" });
    log(`sent ${row.id} (${row.label})`);
  }

  // Stage sync runs over EVERY case in the view (seen or not), independent
  // of the fresh-case loop above — a case's status can keep changing on
  // QContact's side long after its deal was created. Only cases with a
  // recorded deal id are touched (never re-derived — see stage-sync.ts for
  // why); "differs" is decided against `dealStages`, not a live GET. Never
  // touches `seen`.
  if (syncStage) {
    // Distinct QContact statuses among stageUnmapped cases (no recorded deal
    // id) — logged once below so it's clear this is cases missing a deal,
    // not a gap in STATUS_TO_STAGE_ID (that's summary.skipped.unknown_status,
    // logged per-case above).
    const unmappedStatuses = new Set<string>();
    for (const row of rows) {
      const caseKey = String(row.id);
      if (dryRun) {
        log(`would sync stage ${row.id} (${row.label}): status=${row.status ?? "null"}`);
        continue;
      }
      const dealId = deals[caseKey];
      if (!dealId) {
        summary.stageUnmapped++;
        unmappedStatuses.add(row.status ?? "null");
        continue;
      }
      const stageId = statusToStageId(row.status);
      if (!stageId) {
        summary.skipped.unknown_status = (summary.skipped.unknown_status ?? 0) + 1;
        log(`skip stage ${row.id} (${row.label}): unknown status ${row.status}`);
        continue;
      }
      if (dealStages[caseKey] === stageId) {
        summary.stageUnchanged++;
        continue;
      }

      const result = await syncStage({ dealId, stage: stageId });
      if (!result.ok) {
        summary.failed++;
        log(`FAILED stage ${row.id} (${row.label}): ${result.error}`);
        continue;
      }
      if (result.action === "not_found") {
        delete deals[caseKey];
        delete dealStages[caseKey];
        summary.skipped.deal_not_found = (summary.skipped.deal_not_found ?? 0) + 1;
        log(`skip stage ${row.id} (${row.label}): deal ${dealId} not found`);
        await saveState(statePath, { seen: [...seen], deals, dealStages, updatedAt: "" });
        continue;
      }

      dealStages[caseKey] = stageId;
      summary.stageSynced++;
      log(`stage synced ${row.id} (${row.label})`);
      await saveState(statePath, { seen: [...seen], deals, dealStages, updatedAt: "" });
    }
    if (summary.stageUnmapped > 0) {
      log(`stage sync: ${summary.stageUnmapped} case(s) have no recorded deal id, so stage sync is skipped for them; statuses: ${[...unmappedStatuses].sort().join(", ")}`);
    }
  }

  return summary;
}

/**
 * How a lock refusal should be surfaced: the stale case (older than
 * LOCK_STALE_AGE_MS but still reading as held) is not normal contention, so
 * it's logged to stderr and made to fail the run non-zero — visible as a
 * failed run in the systemd journal, instead of a silent no-op every 15
 * minutes. A fresh, genuinely-active lock logs to stdout and exits 0.
 */
export function describeLockRefusal(lockPath: string, result: Extract<AcquireLockResult, { ok: false }>): {
  stream: "stdout" | "stderr";
  message: string;
  exitCode: 0 | 1;
} {
  const ageSec = Math.round(result.ageMs / 1000);
  if (result.stale) {
    return {
      stream: "stderr",
      message: `qcontact-import lock ${lockPath} is ${ageSec}s old and still looks held; refusing to run — check whether it's stuck and remove it if so\n`,
      exitCode: 1,
    };
  }
  return {
    stream: "stdout",
    message: `another qcontact-import run is already in progress (lock ${lockPath}, ${ageSec}s old); exiting\n`,
    exitCode: 0,
  };
}

async function main(): Promise<void> {
  const env = readEnv(process.env);
  const dryRun = process.argv.includes("--dry-run");
  const lockPath = `${env.QCONTACT_IMPORT_STATE}.lock`;
  const lock = await acquireLock(lockPath);
  if (!lock.ok) {
    const { stream, message, exitCode } = describeLockRefusal(lockPath, lock);
    process[stream].write(message);
    process.exitCode = exitCode;
    return;
  }
  try {
    await runMain(env, dryRun);
  } finally {
    await lock.release();
  }
}

async function runMain(env: Env, dryRun: boolean): Promise<void> {
  const qc = new QContactClient({
    baseUrl: env.QCONTACT_BASE_URL,
    email: env.QCONTACT_IMPORT_EMAIL,
    password: env.QCONTACT_IMPORT_PASSWORD,
  });
  const ensureDeal = env.QCONTACT_DEAL_PIPELINE_ID
    ? leadstackDealEnsurer({
        LEADSTACK_API_URL: env.LEADSTACK_API_URL,
        LEADSTACK_API_KEY: env.LEADSTACK_API_KEY,
        QCONTACT_DEAL_PIPELINE_ID: env.QCONTACT_DEAL_PIPELINE_ID,
        QCONTACT_DEAL_STAGE: env.QCONTACT_DEAL_STAGE,
        QCONTACT_DEAL_OWNER_UID: env.QCONTACT_DEAL_OWNER_UID,
      })
    : undefined;
  const syncStage =
    env.QCONTACT_DEAL_PIPELINE_ID && env.QCONTACT_SYNC_STAGES !== "0"
      ? leadstackStageSyncer({
          LEADSTACK_API_URL: env.LEADSTACK_API_URL,
          LEADSTACK_API_KEY: env.LEADSTACK_API_KEY,
        })
      : undefined;
  const summary = await runImport({
    qc, view: env.QCONTACT_IMPORT_VIEW, statePath: env.QCONTACT_IMPORT_STATE,
    upsert: leadstackUpserter(env), ensureDeal, syncStage,
    getLocation: (id) => qc.getLocation(id),
    dryRun,
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
