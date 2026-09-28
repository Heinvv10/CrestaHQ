import { beforeEach, describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { createMemoryFirestore } from "../../src/test/memory-firestore";
import { MODEL_ID, backfillR0b, parseArgs, planReport } from "./backfill-r0b";

/**
 * The R0b backfill over an in-memory Firestore shaped like #1000's pre-R0
 * reports: the dry run writes nothing; `--write` changes exactly the
 * documents the dry run listed; stamped (R0) reports and queued/running ones
 * are never marked pre-R0.
 */

let mem: ReturnType<typeof createMemoryFirestore>;
const db = () => mem.db as unknown as Firestore;

const OLD_AI_TEXT =
  "AI assistants (gemini-2.5-flash, gpt-4o-mini) did not name the business in any of 6 answers to local searches for its services.";

const preR0Sections = () => [
  { key: "listings", status: "ok", score: 0, findings: [], raw: { checks: [{ directory: "Bing", url: null, status: "not_found" }] } },
  { key: "reputation", status: "ok", score: 80, findings: [], raw: { rating: 4.6, reviewsCount: 37, velocity90d: "notMeasured" } },
  {
    key: "lead_capture", status: "ok", score: 80,
    findings: [{ code: "no_chat_widget", text: "The website has no live chat." }],
    raw: { whatsapp: true, booking: true, contactForm: true, phoneLink: true, chatWidget: false },
  },
  {
    key: "ai_presence", status: "ok", score: 0,
    findings: [{ code: "not_in_ai_answers", text: OLD_AI_TEXT }],
    raw: { mentionedIn: 0, answersMeasured: 6, models: "gemini-2.5-flash, gpt-4o-mini", topCompetitors: null },
  },
];

function seed() {
  mem = createMemoryFirestore();
  const base = { agencyId: "ag1", subAccountId: "sa1", createdByUid: "u1" };
  // The contact's latest report: every kind of change, and a re-stamp.
  mem.seed("prospectReports/old1", { ...base, contactId: "c1", status: "ready", sections: preR0Sections(), headline: OLD_AI_TEXT });
  mem.seed("contacts/c1", { subAccountId: "sa1", prospecting: { lastReportId: "old1", lastReportHeadline: OLD_AI_TEXT } });
  // An older report of the same contact: rescored, but its contact is not re-stamped.
  mem.seed("prospectReports/old0", { ...base, contactId: "c1", status: "ready", sections: preR0Sections(), headline: OLD_AI_TEXT });
  // An R0 report shaped exactly like old1: never touched.
  mem.seed("prospectReports/r0", {
    ...base, contactId: "c2", status: "ready", sections: preR0Sections(), headline: OLD_AI_TEXT,
    announceProtocol: 1, announceDueAt: null, announcedAt: null,
  });
  mem.seed("contacts/c2", { subAccountId: "sa1", prospecting: { lastReportId: "r0", lastReportHeadline: OLD_AI_TEXT } });
  // Queued before the deploy: must stay unannounced so the R0 worker announces it once.
  mem.seed("prospectReports/queued", { ...base, contactId: "c3", status: "queued", sections: [], headline: null });
  // Running with pre-R0-shaped sections: not settled, so never rescored or marked.
  mem.seed("prospectReports/running", {
    ...base, contactId: "c4", status: "running", sections: preR0Sections(), headline: OLD_AI_TEXT,
  });
  mem.seed("contacts/c4", { subAccountId: "sa1", prospecting: { lastReportId: "running", lastReportHeadline: OLD_AI_TEXT } });
  // Already announced, nothing to rescore: unchanged.
  mem.seed("prospectReports/done", {
    ...base, contactId: "c3", status: "failed", sections: [], headline: null, announcedAt: new Date(), announceReason: "pre-R0",
  });
}

const snapshotAll = () =>
  Object.fromEntries(
    ["prospectReports/old1", "prospectReports/old0", "prospectReports/r0", "prospectReports/queued", "prospectReports/running", "prospectReports/done", "contacts/c1", "contacts/c2", "contacts/c4"].map(
      (p) => [p, JSON.stringify(mem.read(p))],
    ),
  );

beforeEach(seed);

describe("parseArgs", () => {
  it("requires --project; --write is opt-in", () => {
    expect(() => parseArgs([])).toThrow("--project");
    expect(() => parseArgs(["--project", "--write"])).toThrow("--project");
    expect(parseArgs(["--project", "p1"])).toEqual({ projectId: "p1", write: false });
    expect(parseArgs(["--project", "p1", "--write"])).toEqual({ projectId: "p1", write: true });
  });
});

describe("dry run", () => {
  it("leaves every document unchanged and lists what it would change", async () => {
    const before = snapshotAll();
    const r = await backfillR0b(db(), { write: false });
    expect(snapshotAll()).toEqual(before);
    expect(r).toMatchObject({ scanned: 6, stampedSkipped: 1, unchanged: 3, written: 0, modelIdsRemaining: [] });
    expect(r.planned.map((p) => p.report).sort()).toEqual(["prospectReports/old0", "prospectReports/old1"]);
    const old1 = r.planned.find((p) => p.report === "prospectReports/old1")!.changes;
    expect(old1).toEqual([
      "section listings: score 0→null",
      "section reputation: score 80→75; findings none→reviews_under_50,rating_under_4_8",
      "section lead_capture: finding text/copy rewritten",
      "section ai_presence: finding text/copy rewritten",
      expect.stringMatching(/^headline ".*gemini-2\.5-flash.*" → "AI assistants like ChatGPT and Gemini did not name/),
      'announcedAt set, announceReason "pre-R0"',
      expect.stringMatching(/^contacts\/c1\.prospecting\.lastReportHeadline /),
    ]);
    expect(r.planned.find((p) => p.report === "prospectReports/old0")!.changes.join("\n")).not.toContain("contacts/");
  });

  it("never lists a stamped report", async () => {
    const r = await backfillR0b(db(), { write: false });
    expect(r.planned.map((p) => p.report)).not.toContain("prospectReports/r0");
  });

  it("the planner itself refuses a stamped report (the write re-plans in its transaction, after a claim may have stamped it)", () => {
    const stamped = mem.read("prospectReports/r0")!;
    expect(planReport("r0", stamped, "c2", mem.read("contacts/c2"))).toBeNull();
    expect(planReport("r0", { ...stamped, announceProtocol: undefined }, "c2", mem.read("contacts/c2"))).not.toBeNull();
  });
});

describe("--write", () => {
  it("changes exactly the documents the dry run listed, and nothing else", async () => {
    const listed = (await backfillR0b(db(), { write: false })).planned.map((p) => p.report);
    const before = snapshotAll();
    const r = await backfillR0b(db(), { write: true });
    expect(r.written).toBe(2);
    const after = snapshotAll();
    const changed = Object.keys(before).filter((p) => before[p] !== after[p]).sort();
    expect(changed).toEqual([...listed, "contacts/c1"].sort());
  });

  it("writes the rescored sections, the new headline and the re-stamped contact in one go", async () => {
    await backfillR0b(db(), { write: true });
    const report = mem.read("prospectReports/old1")!;
    const sections = report.sections as { key: string; score: number | null; findings: { text: string; impact?: string }[] }[];
    expect(sections.map((s) => [s.key, s.score])).toEqual([["listings", null], ["reputation", 75], ["lead_capture", 80], ["ai_presence", 0]]);
    expect(sections[1]!.findings.every((f) => typeof f.impact === "string")).toBe(true);
    expect(report.headline).toMatch(/^AI assistants like ChatGPT and Gemini did not name the business in any of 6 answers/);
    expect(report.announceReason).toBe("pre-R0");
    expect(report.announcedAt).toBeTruthy();
    expect((mem.read("contacts/c1")!.prospecting as { lastReportHeadline: string }).lastReportHeadline).toBe(report.headline);
    // Stored text; raw.models keeps the ids for the member view by design.
    const text = [report.headline, mem.read("contacts/c1")!.prospecting, sections.map((s) => s.findings)];
    expect(JSON.stringify(text)).not.toMatch(MODEL_ID);
  });

  it("the pre-R0 marking skips stamped reports and queued/running ones", async () => {
    await backfillR0b(db(), { write: true });
    expect(mem.read("prospectReports/r0")!.announcedAt).toBeNull();
    expect(mem.read("prospectReports/r0")!.announceReason).toBeUndefined();
    expect(mem.read("prospectReports/queued")!.announcedAt).toBeUndefined();
  });

  it("a queued/running report is skipped entirely, even with pre-R0 sections: no rescore, no headline, no re-stamp", async () => {
    const before = [mem.read("prospectReports/running"), mem.read("contacts/c4")].map((d) => JSON.stringify(d));
    await backfillR0b(db(), { write: true });
    expect([mem.read("prospectReports/running"), mem.read("contacts/c4")].map((d) => JSON.stringify(d))).toEqual(before);
  });

  it("is idempotent: a second run plans nothing", async () => {
    await backfillR0b(db(), { write: true });
    const again = await backfillR0b(db(), { write: false });
    expect(again.planned).toEqual([]);
  });
});
