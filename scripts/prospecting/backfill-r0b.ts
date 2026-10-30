/**
 * One-off backfill for prospect reports stored before R0
 * (docs/programme/prospect-report-redesign-sow.md, "Existing reports").
 * Per settled (ready/failed) report without `announceProtocol`:
 *
 *   - rescores the sections that are pure over stored `raw`: listings (no
 *     score), reputation and lead_capture (score from findings, with copy);
 *   - rewrites the `not_in_ai_answers` text that named model ids (C4);
 *     and the `ai_mentions_partial` text, in the scorer's own wording;
 *   - recomputes `headline`, and re-stamps `prospecting.lastReportHeadline`
 *     on the contact whose `lastReportId` it is, in the same transaction, so
 *     the page and `{{prospecting.headline}}` never diverge;
 *   - with no `announcedAt`, sets `announcedAt` with `announceReason:
 *     "pre-R0"`: it already fired `prospecting.report.ready` at ready.
 *
 * Never touched: a report carrying `announceProtocol` (made by R0), and a
 * queued/running one (the R0 worker that claims it scores it with R0 code
 * and announces it once).
 * Nothing external is called.
 *
 * Run with Node 22:
 *   node --env-file=.env.local --experimental-strip-types \
 *     scripts/prospecting/backfill-r0b.ts --project <firebase-project-id> [--write]
 *
 * Dry run by default: reads only, prints every document it would change and
 * how. `--project` must match the credential's project. `--write` re-reads
 * each planned report and its contact in a transaction, re-plans (a live
 * write in between is re-planned, not overwritten), and writes only that
 * plan. Safe to rerun: a second run plans nothing.
 */
import { pathToFileURL } from "node:url";
import { cert, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore, type Firestore } from "firebase-admin/firestore";
// Relative `.ts` imports: `node --experimental-strip-types` cannot resolve `@/`.
import { aiMentionsPartialText, notInAiAnswersText } from "../../src/lib/prospecting/sections/ai-presence.ts";
import { finding } from "../../src/lib/prospecting/sections/findings.ts";
import * as leadCapture from "../../src/lib/prospecting/sections/lead-capture.ts";
import * as reputation from "../../src/lib/prospecting/sections/reputation.ts";
import { headline } from "../../src/lib/prospecting/severity.ts";
import type { ProspectSectionResult } from "../../src/types/prospecting.ts";

type Data = Record<string, unknown>;

export interface BackfillArgs {
  projectId: string;
  write: boolean;
}

export function parseArgs(argv: string[]): BackfillArgs {
  const i = argv.indexOf("--project");
  const projectId = i === -1 ? "" : (argv[i + 1] ?? "");
  if (!projectId || projectId.startsWith("--")) throw new Error("--project <firebase-project-id> is required");
  return { projectId, write: argv.includes("--write") };
}

export interface ReportPlan {
  reportId: string;
  /** One human-readable line per change. */
  changes: string[];
  /** Fields to set on the report (announcedAt is added by the writer). */
  patch: Data;
  markPreR0: boolean;
  /** Set when the contact's `lastReportHeadline` is re-stamped. */
  contact: { id: string; headline: string | null } | null;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Any id shaped like a provider's model name. */
export const MODEL_ID = /\b(gpt-\d|gemini-\d|claude-\d|sonar\b|llama-?\d|mistral)/i;

/** A section rescored from its stored raw; sections not pure over raw are returned as they are. */
export function rescore(s: ProspectSectionResult): ProspectSectionResult {
  if (s.status !== "ok") return s;
  const raw = s.raw ?? {};
  switch (s.key) {
    case "listings":
      return { ...s, score: null, findings: [] };
    case "reputation":
      return { ...s, ...reputation.score({ rating: num(raw.rating), reviewsCount: num(raw.reviewsCount) }) };
    case "lead_capture":
      return {
        ...s,
        ...leadCapture.score({
          whatsapp: raw.whatsapp === true,
          booking: raw.booking === true,
          contactForm: raw.contactForm === true,
          phoneLink: raw.phoneLink === true,
          chatWidget: raw.chatWidget === true,
        }),
      };
    case "ai_presence": {
      const answers = num(raw.answersMeasured);
      if (answers === null) return s;
      const mentioned = num(raw.mentionedIn);
      return {
        ...s,
        findings: s.findings.map((f) =>
          f.code === "not_in_ai_answers"
            ? finding("not_in_ai_answers", notInAiAnswersText(answers))
            : f.code === "ai_mentions_partial" && mentioned !== null
              ? finding("ai_mentions_partial", aiMentionsPartialText(mentioned, answers))
              : f,
        ),
      };
    }
    default:
      return s;
  }
}

/** JSON with sorted keys: the stored and rescored sections compare by value, not key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Data;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "undefined";
}

const codesOf = (s: ProspectSectionResult) => (s.findings ?? []).map((f) => f.code).join(",") || "none";

/** Null = nothing to change (or an R0 report, which is never touched). Pure. */
export function planReport(reportId: string, report: Data, contactId: string | null, contact: Data | undefined): ReportPlan | null {
  if (report.announceProtocol !== undefined) return null;
  if (report.status !== "ready" && report.status !== "failed") return null;
  const changes: string[] = [];
  const patch: Data = {};

  const stored = (report.sections ?? []) as ProspectSectionResult[];
  const sections = stored.map(rescore);
  stored.forEach((before, i) => {
    const after = sections[i]!;
    if (canonical(before) === canonical(after)) return;
    const detail = [
      before.score !== after.score ? `score ${before.score}→${after.score}` : null,
      codesOf(before) !== codesOf(after) ? `findings ${codesOf(before)}→${codesOf(after)}` : null,
      codesOf(before) === codesOf(after) && before.score === after.score ? "finding text/copy rewritten" : null,
    ].filter(Boolean);
    changes.push(`section ${after.key}: ${detail.join("; ")}`);
  });
  if (changes.length > 0) patch.sections = sections;

  const nextHeadline = headline(sections);
  const storedHeadline = typeof report.headline === "string" ? report.headline : null;
  if (nextHeadline !== storedHeadline) {
    patch.headline = nextHeadline;
    changes.push(`headline ${JSON.stringify(storedHeadline)} → ${JSON.stringify(nextHeadline)}`);
  }

  const markPreR0 = (report.announcedAt ?? null) === null;
  if (markPreR0) changes.push('announcedAt set, announceReason "pre-R0"');

  const prospecting = (contact?.prospecting ?? {}) as Data;
  let restamp: ReportPlan["contact"] = null;
  if (contactId && prospecting.lastReportId === reportId && (prospecting.lastReportHeadline ?? null) !== nextHeadline) {
    restamp = { id: contactId, headline: nextHeadline };
    changes.push(
      `contacts/${contactId}.prospecting.lastReportHeadline ${JSON.stringify(prospecting.lastReportHeadline ?? null)} → ${JSON.stringify(nextHeadline)}`,
    );
  }

  return changes.length > 0 ? { reportId, changes, patch, markPreR0, contact: restamp } : null;
}

export interface BackfillResult {
  write: boolean;
  scanned: number;
  /** Reports carrying `announceProtocol`: R0-made, never planned or written. */
  stampedSkipped: number;
  unchanged: number;
  planned: { report: string; changes: string[] }[];
  written: number;
  /** Planned text that would still carry a model id (expected: none). */
  modelIdsRemaining: string[];
}

export async function backfillR0b(db: Firestore, args: Pick<BackfillArgs, "write">): Promise<BackfillResult> {
  const r: BackfillResult = {
    write: args.write,
    scanned: 0,
    stampedSkipped: 0,
    unchanged: 0,
    planned: [],
    written: 0,
    modelIdsRemaining: [],
  };
  const readPair = async (reportId: string, get: (path: string) => Promise<Data | undefined>) => {
    const report = await get(`prospectReports/${reportId}`);
    const contactId = typeof report?.contactId === "string" && report.contactId ? report.contactId : null;
    return { report, contactId, contact: contactId ? await get(`contacts/${contactId}`) : undefined };
  };

  const reports = await db.collection("prospectReports").get();
  for (const doc of reports.docs) {
    r.scanned++;
    if (doc.data().announceProtocol !== undefined) {
      r.stampedSkipped++;
      continue;
    }
    const { report, contactId, contact } = await readPair(doc.id, async (p) => (await db.doc(p).get()).data());
    const plan = report ? planReport(doc.id, report, contactId, contact) : null;
    if (!plan) {
      r.unchanged++;
      continue;
    }
    r.planned.push({ report: `prospectReports/${doc.id}`, changes: plan.changes });
    // Stored text only: `raw.models` keeps the model ids for the member view by design.
    const sections = (plan.patch.sections ?? report!.sections ?? []) as ProspectSectionResult[];
    const text = [plan.patch.headline ?? report!.headline, ...sections.flatMap((s) => s.findings.map((f) => f.text))];
    if (MODEL_ID.test(JSON.stringify(text))) r.modelIdsRemaining.push(`prospectReports/${doc.id}`);
    if (!args.write) continue;

    const wrote = await db.runTransaction(async (tx) => {
      const now = await readPair(doc.id, async (p) => (await tx.get(db.doc(p))).data());
      const current = now.report ? planReport(doc.id, now.report, now.contactId, now.contact) : null;
      if (!current) return false;
      tx.update(db.doc(`prospectReports/${doc.id}`), {
        ...current.patch,
        ...(current.markPreR0 ? { announcedAt: FieldValue.serverTimestamp(), announceReason: "pre-R0" } : {}),
      });
      if (current.contact) {
        tx.update(db.doc(`contacts/${current.contact.id}`), { "prospecting.lastReportHeadline": current.contact.headline });
      }
      return true;
    });
    if (wrote) r.written++;
  }
  return r;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  if (args.projectId !== process.env.FIREBASE_ADMIN_PROJECT_ID) {
    throw new Error(`--project ${args.projectId} does not match the credential's project`);
  }
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
      clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
  console.log(JSON.stringify(await backfillR0b(getFirestore(), args), null, 2));
}
