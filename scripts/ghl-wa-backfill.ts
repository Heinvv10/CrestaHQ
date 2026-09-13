/**
 * V1 (docs/parity/sp2.md): Velocity #1002 WhatsApp history has a ~31h hole —
 * the GHL import froze at 2026-09-10T07:14:03Z and the Cloud webhook went
 * live only from ~2026-09-11T12:00Z. This script reads GHL's message export
 * for that window, dedupes against what LeadStack already holds, and reports
 * what's missing. It NEVER writes without an explicit, matching `--confirm`
 * AND `--approved-report`.
 *
 * Run with Node 22:
 *   node --env-file=.env.local --experimental-strip-types scripts/ghl-wa-backfill.ts [--out <path>]
 *
 * `--write --confirm <n> --approved-report <path>` is implemented but is a
 * second, deliberate step (see `assertWriteMatchesApprovedReport` in
 * ghl-wa-backfill-lib.ts): the write run recomputes the missing set fresh and
 * refuses unless it EXACTLY matches the ids in the approved dry-run report,
 * not just a count. Do not pass it without Hein's explicit go-ahead on a
 * specific report file.
 *
 * Unresolved contacts (no importMappings entry, and no phone match) are
 * REPORTED ONLY — ids and message counts. This script never creates a
 * contact; that's a separate decision for Hein (PR #102 review, decision 1).
 *
 * GHL credential: a location-level Private Integration Token for Velocity
 * Fibre (locationId RcmH5ytbrwH5AXDF2xxr), resolved from (first hit wins):
 *   GHL_TOKEN_FILE_VELOCITY_FIBRE (path) > GHL_TOKEN_DIR/velocity-fibre >
 *   GHL_TOKEN_VELOCITY_FIBRE (inline) > GHL_TOKEN_FILE / GHL_TOKEN.
 * A file already exists at ~/.config/apexsignal/ghl-tokens/velocity-fibre
 * (created 2026-08-09 for ApexSignal's read-only GHL exporter; see
 * ApexSignal/scripts/ghl-export/tokens.ts, whose resolution order this
 * mirrors). The token is never printed or logged.
 *
 * The agency is on a failed-payment hold (2026-09-11). The API may refuse
 * outright; a 401/403 aborts the whole run rather than being read as "zero
 * messages in this window" — see `fetchAllMessages` in ghl-wa-backfill-io.ts.
 */
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { missingTotal, unresolvedMissingTotal } from "./ghl-wa-backfill-lib.ts";
import { assertWriteMatchesApprovedReport, parseArgs } from "./ghl-wa-backfill-guards.ts";
import { VELOCITY_LOCATION_ID, WINDOW_END, WINDOW_START, fetchAllMessages, resolveVelocityToken } from "./ghl-wa-backfill-client.ts";
import { VELOCITY_SUB_ACCOUNT_ID, checkWatchdogActive, runDryRun, runWrite } from "./ghl-wa-backfill-io.ts";

const VELOCITY_AGENCY_ID_ENV = "VELOCITY_AGENCY_ID"; // resolved from the sub-account doc at runtime instead of hardcoding

interface ApprovedReport {
  missingGhlMessageIds?: unknown;
}

async function readApprovedReport(filePath: string): Promise<string[]> {
  const contents = await readFile(filePath, "utf8");
  const parsed = JSON.parse(contents) as ApprovedReport;
  if (!Array.isArray(parsed.missingGhlMessageIds)) {
    throw new Error(`${filePath} has no "missingGhlMessageIds" array — is this a dry-run report from this script?`);
  }
  return parsed.missingGhlMessageIds.filter((x): x is string => typeof x === "string");
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }
  const outPath =
    args.out ??
    path.join(os.tmpdir(), `ghl-wa-backfill-velocity-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

  const resolvedToken = await resolveVelocityToken();
  if (!resolvedToken) {
    console.error(
      "No GHL credential found for Velocity Fibre. Expected one of: " +
        "GHL_TOKEN_FILE_VELOCITY_FIBRE, GHL_TOKEN_DIR/velocity-fibre, " +
        "GHL_TOKEN_VELOCITY_FIBRE, GHL_TOKEN_FILE, GHL_TOKEN. " +
        "A location-level Private Integration Token for Velocity Fibre " +
        `(locationId ${VELOCITY_LOCATION_ID}) is required — an agency-level ` +
        "token 401s on conversation reads (see ApexSignal/scripts/ghl-export/tokens.ts).",
    );
    process.exit(1);
    return;
  }
  console.log(`GHL token source: ${resolvedToken.source}`);

  const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKey) {
    console.error("Missing FIREBASE_ADMIN_PROJECT_ID / _CLIENT_EMAIL / _PRIVATE_KEY (.env.local).");
    process.exit(1);
    return;
  }
  const app = initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  const db = getFirestore(app);

  const subAccountSnap = await db.doc(`subAccounts/${VELOCITY_SUB_ACCOUNT_ID}`).get();
  const subAccount = subAccountSnap.data();
  const agencyId = (subAccount?.agencyId as string | undefined) ?? process.env[VELOCITY_AGENCY_ID_ENV];
  if (!agencyId) {
    console.error(`Could not resolve agencyId for sub-account ${VELOCITY_SUB_ACCOUNT_ID}.`);
    process.exit(1);
    return;
  }
  const defaultPhoneCountry = (subAccount?.defaultPhoneCountry as string | null | undefined) ?? null;
  console.log(
    defaultPhoneCountry
      ? `Sub-account defaultPhoneCountry: ${defaultPhoneCountry}`
      : "Sub-account has no defaultPhoneCountry set — using ZA as the phone-fallback default.",
  );

  const watchdog = await checkWatchdogActive(db, subAccount);
  console.log(
    `Watchdog check: labsEnabledByAgency=${watchdog.labsEnabledByAgency} ` +
      `aiSuiteEnabledByAgency=${watchdog.aiSuiteEnabledByAgency} agentEnabled=${watchdog.agentEnabled} ` +
      `=> active=${watchdog.active}.` +
      (watchdog.active
        ? " Conversations whose newest backfilled message would arm a fresh watchdog candidate are skipped (see decideConversationAdvance)."
        : " Inactive — advancing lastMessageAt is unconditionally safe."),
  );

  console.log(`Fetching GHL WhatsApp export for Velocity, window ${WINDOW_START} .. ${WINDOW_END} ...`);
  let raw;
  try {
    raw = await fetchAllMessages(resolvedToken.token);
  } catch (err) {
    console.error("GHL fetch failed — refusing to report a partial result as complete.");
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }
  console.log(`Fetched ${raw.length} raw export rows (deduped by id; all non-email channels, window-filtered by GHL).`);

  let dryRun;
  try {
    dryRun = await runDryRun(db, resolvedToken.token, raw, defaultPhoneCountry);
  } catch (err) {
    console.error("Dry run failed (a contact-phone lookup returned something other than 404) — aborting.");
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    window: { start: WINDOW_START, end: WINDOW_END },
    locationId: VELOCITY_LOCATION_ID,
    subAccountId: VELOCITY_SUB_ACCOUNT_ID,
    defaultPhoneCountry: defaultPhoneCountry ?? "ZA (fallback — sub-account has none set)",
    watchdog,
    counts: dryRun.counts,
    contactsNotFoundGhlIds: dryRun.contactsNotFoundIds,
    missingGhlMessageIds: dryRun.missing.map((m) => m.ghlMessageId),
    unresolvedMissingGhlMessageIds: dryRun.unresolvedMissing.map((m) => m.ghlMessageId),
  };
  console.log(JSON.stringify(report.counts, null, 2));
  await writeFile(outPath, JSON.stringify(report, null, 2));
  console.log(`Report written to ${outPath}`);
  console.log(
    `${dryRun.contactsNotFoundIds.length} GHL contacts don't resolve (no verified importMappings entry, no phone match), ` +
      `carrying ${unresolvedMissingTotal(dryRun.counts)} messages ` +
      `(${dryRun.counts.unresolvedMissingInbound} inbound, ${dryRun.counts.unresolvedMissingOutbound} outbound). ` +
      "Reported only — this script never creates a contact.",
  );

  if (args.write) {
    if (!args.approvedReport) {
      console.error("--write requires --approved-report <path-to-dry-run-json> in addition to --confirm.");
      process.exit(1);
      return;
    }
    let approvedIds: string[];
    try {
      approvedIds = await readApprovedReport(args.approvedReport);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
      return;
    }
    try {
      assertWriteMatchesApprovedReport(report.missingGhlMessageIds, approvedIds, args.confirm);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
      return;
    }
    console.log(`Confirmed against ${args.approvedReport} — writing ${missingTotal(dryRun.counts)} messages...`);
    const writeResult = await runWrite(db, dryRun.missing, agencyId, watchdog);
    console.log(
      `Write complete. Conversations skipped: ${writeResult.conversationsSkippedMissing} (no conversation doc), ` +
        `${writeResult.conversationsSkippedWatchdog} (would arm the watchdog).`,
    );
  } else {
    console.log(
      `Dry run only. To write, get this report approved, then re-run with: ` +
        `--write --confirm ${missingTotal(dryRun.counts)} --approved-report ${outPath}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
