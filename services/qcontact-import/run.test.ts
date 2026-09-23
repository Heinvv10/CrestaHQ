import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, describeLockRefusal, LOCK_STALE_AGE_MS, leadstackUpserter, loadState, runImport, saveState, type Env } from "./run.ts";

// Real fs/promises by default (each call falls through) — only the one
// "create-then-write race" test below overrides a single readFile call.
vi.mock("node:fs/promises", { spy: true });
import type { CaseDetail, CaseRow, ContactDetail } from "./qcontact.ts";
import type { UpsertBody } from "./map.ts";
import type { DealEnsurer } from "./deals.ts";
import type { StageSyncer } from "./stage-sync.ts";

const row = (id: number, created: string, status: string | null = "New"): CaseRow =>
  ({ id, label: `FT${id}`, created_at: created, status, category: "New Installation" });

function fakeQc(rows: CaseRow[], phones: Record<number, string | null> = {}) {
  return {
    listView: vi.fn(async () => rows),
    getCase: vi.fn(async (id: number): Promise<CaseDetail> =>
      ({ id, label: `FT${id}`, lookup_contact_id: id * 10, fields: { reference: `FT${id}` } })),
    getContact: vi.fn(async (id: number): Promise<ContactDetail> => {
      const caseId = id / 10;
      const phone = phones[caseId] === undefined ? `e164:2779${String(caseId).padStart(7, "0")}` : phones[caseId];
      return { id, label: "Test Person", fields: { first_name: "Test", last_name: "Person", ...(phone ? { telephone: phone } : {}) } };
    }),
  };
}

let dir: string;
let statePath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "qc-import-"));
  statePath = join(dir, "state.json");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const log = () => {};

describe("runImport", () => {
  it("first run with no state file seeds every case as seen and sends nothing", async () => {
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-x" }));
    const s = await runImport({ qc: fakeQc([row(1, "2026-09-01"), row(2, "2026-09-02")]), view: "v", statePath, upsert, dryRun: false, log });
    expect(s).toMatchObject({ mode: "seed", inView: 2, sent: 0 });
    expect(upsert).not.toHaveBeenCalled();
    expect((await loadState(statePath))?.seen).toEqual([1, 2]);
  });

  it("a later run sends only the cases not yet seen, oldest first, and marks them seen", async () => {
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-x" }));
    const seeded = [row(1, "2026-09-01")];
    await runImport({ qc: fakeQc(seeded), view: "v", statePath, upsert, dryRun: false, log });
    const s = await runImport({
      qc: fakeQc([...seeded, row(3, "2026-09-05"), row(2, "2026-09-03")]),
      view: "v", statePath, upsert, dryRun: false, log,
    });
    expect(s).toMatchObject({ mode: "import", fresh: 2, sent: 2, failed: 0 });
    const bodies = upsert.mock.calls.map((c) => (c as unknown as [UpsertBody])[0]);
    expect(bodies.map((b) => b.custom_fields.qcontact_case_id)).toEqual(["2", "3"]);
    expect(bodies[0]).toMatchObject({ phone: "+27790000002", tags_add: ["qcontact-install"] });
    expect((await loadState(statePath))?.seen.sort()).toEqual([1, 2, 3]);
  });

  it("running twice on the same view sends zero the second time", async () => {
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-x" }));
    const rows = [row(1, "2026-09-01")];
    await runImport({ qc: fakeQc(rows), view: "v", statePath, upsert, dryRun: false, log });
    await runImport({ qc: fakeQc([...rows, row(2, "2026-09-02")]), view: "v", statePath, upsert, dryRun: false, log });
    const again = await runImport({ qc: fakeQc([...rows, row(2, "2026-09-02")]), view: "v", statePath, upsert, dryRun: false, log });
    expect(again).toMatchObject({ fresh: 0, sent: 0 });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("a failed upsert is NOT marked seen, so the next run retries it", async () => {
    const upsert = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "HTTP 500" })
      .mockResolvedValue({ ok: true, contactId: "contact-x" });
    await runImport({ qc: fakeQc([]), view: "v", statePath, upsert, dryRun: false, log });
    const first = await runImport({ qc: fakeQc([row(2, "2026-09-02")]), view: "v", statePath, upsert, dryRun: false, log });
    expect(first).toMatchObject({ sent: 0, failed: 1 });
    expect((await loadState(statePath))?.seen).toEqual([]);
    const second = await runImport({ qc: fakeQc([row(2, "2026-09-02")]), view: "v", statePath, upsert, dryRun: false, log });
    expect(second).toMatchObject({ sent: 1, failed: 0 });
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it("a case with no phone is skipped, counted, and marked seen (nothing to retry)", async () => {
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-x" }));
    await runImport({ qc: fakeQc([]), view: "v", statePath, upsert, dryRun: false, log });
    const s = await runImport({ qc: fakeQc([row(2, "2026-09-02")], { 2: null }), view: "v", statePath, upsert, dryRun: false, log });
    expect(s).toMatchObject({ sent: 0, skipped: { no_phone: 1 } });
    expect(upsert).not.toHaveBeenCalled();
    expect((await loadState(statePath))?.seen).toEqual([2]);
  });

  it("a malformed 2xx upsert response (via the real leadstackUpserter) fails only that case and still processes the next one", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("not json", { status: 201 }))
      .mockResolvedValueOnce(new Response('{"contact":{"id":"c2"}}', { status: 201 }));
    const upsert = leadstackUpserter(
      { LEADSTACK_API_URL: "https://crm.test", LEADSTACK_API_KEY: "sk_test" } as Env,
      fetchImpl as unknown as typeof fetch,
    );
    await runImport({ qc: fakeQc([]), view: "v", statePath, upsert, dryRun: false, log });
    const s = await runImport({
      qc: fakeQc([row(1, "2026-09-01"), row(2, "2026-09-02")]),
      view: "v", statePath, upsert, dryRun: false, log,
    });
    expect(s).toMatchObject({ fresh: 2, sent: 1, failed: 1 });
    expect((await loadState(statePath))?.seen).toEqual([2]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("dry-run neither calls the upsert nor writes state", async () => {
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-x" }));
    await runImport({ qc: fakeQc([]), view: "v", statePath, upsert, dryRun: false, log });
    const before = await readFile(statePath, "utf8");
    const s = await runImport({ qc: fakeQc([row(2, "2026-09-02")]), view: "v", statePath, upsert, dryRun: true, log });
    expect(s).toMatchObject({ mode: "dry-run", fresh: 1, sent: 1 });
    expect(upsert).not.toHaveBeenCalled();
    expect(await readFile(statePath, "utf8")).toBe(before);
  });
});

describe("runImport with ensureDeal", () => {
  it("no ensureDeal passed → no deal decisions are made, case still sent and marked seen", async () => {
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-2" }));
    await runImport({ qc: fakeQc([]), view: "v", statePath, upsert, dryRun: false, log });
    const s = await runImport({ qc: fakeQc([row(2, "2026-09-02")]), view: "v", statePath, upsert, dryRun: false, log });
    expect(s).toMatchObject({ sent: 1, failed: 0 });
    expect((await loadState(statePath))?.seen).toEqual([2]);
  });

  it("calls ensureDeal with the upserted contact id, case id and a title built from name + case ref, and records the deal id", async () => {
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-2" }));
    const ensureDeal: DealEnsurer = vi.fn(async () => ({ ok: true as const, dealId: "deal-2" }));
    await runImport({ qc: fakeQc([]), view: "v", statePath, upsert, ensureDeal, dryRun: false, log });
    const s = await runImport({ qc: fakeQc([row(2, "2026-09-02")]), view: "v", statePath, upsert, ensureDeal, dryRun: false, log });
    expect(s).toMatchObject({ sent: 1, failed: 0 });
    expect(ensureDeal).toHaveBeenCalledWith({
      contactId: "contact-2",
      caseId: 2,
      title: "Install request — Test Person (FT2)",
    });
    expect((await loadState(statePath))?.seen).toEqual([2]);
    expect((await loadState(statePath))?.deals).toEqual({ "2": "deal-2" });
  });

  it("records the deal id even when ensureDeal found an existing deal rather than creating one", async () => {
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-2" }));
    const ensureDeal: DealEnsurer = vi.fn(async () => ({ ok: true as const, dealId: "deal-preexisting" }));
    await runImport({ qc: fakeQc([]), view: "v", statePath, upsert, ensureDeal, dryRun: false, log });
    await runImport({ qc: fakeQc([row(2, "2026-09-02")]), view: "v", statePath, upsert, ensureDeal, dryRun: false, log });
    expect((await loadState(statePath))?.deals).toEqual({ "2": "deal-preexisting" });
  });

  it("a failed deal step leaves the case unseen and counts it failed, even though the upsert succeeded, and records no deal id", async () => {
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-2" }));
    const ensureDeal: DealEnsurer = vi.fn(async () => ({ ok: false as const, error: "HTTP 500 creating deal" }));
    await runImport({ qc: fakeQc([]), view: "v", statePath, upsert, ensureDeal, dryRun: false, log });
    const s = await runImport({ qc: fakeQc([row(2, "2026-09-02")]), view: "v", statePath, upsert, ensureDeal, dryRun: false, log });
    expect(s).toMatchObject({ sent: 0, failed: 1 });
    expect((await loadState(statePath))?.seen).toEqual([]);
    expect((await loadState(statePath))?.deals).toEqual({});
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("dry-run never calls ensureDeal", async () => {
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-2" }));
    const ensureDeal: DealEnsurer = vi.fn(async () => ({ ok: true as const, dealId: "deal-2" }));
    await runImport({ qc: fakeQc([]), view: "v", statePath, upsert, ensureDeal, dryRun: false, log });
    const s = await runImport({ qc: fakeQc([row(2, "2026-09-02")]), view: "v", statePath, upsert, ensureDeal, dryRun: true, log });
    expect(s).toMatchObject({ mode: "dry-run", sent: 1 });
    expect(ensureDeal).not.toHaveBeenCalled();
  });
});

describe("runImport with getLocation", () => {
  const qcWithPin = (pin: string | undefined, ids: number[] = [1]) => ({
    listView: vi.fn(async () => ids.map((id) => row(id, `2026-09-0${id}`))),
    getCase: vi.fn(async (id: number): Promise<CaseDetail> => ({
      id, label: `FT${id}`, lookup_contact_id: id * 10,
      fields: { reference: `FT${id}`, ...(pin !== undefined ? { c__location_pin: pin } : {}) },
    })),
    getContact: vi.fn(async (id: number): Promise<ContactDetail> => ({
      id, label: "Test Person", fields: { first_name: "Test", last_name: "Person", telephone: "e164:27790000001" },
    })),
  });

  it("a pin that resolves to a valid in-bounds location writes qcontact_location_gps and counts locationsResolved", async () => {
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-x" }));
    const getLocation = vi.fn(async () => ({ id: 500, label: "Loc", fields: { c__latitude: -26.1, c__longitude: 28.5 } }));
    await runImport({ qc: qcWithPin("500", []), view: "v", statePath, upsert, getLocation, dryRun: false, log });
    const s = await runImport({ qc: qcWithPin("500", [1]), view: "v", statePath, upsert, getLocation, dryRun: false, log });
    expect(s).toMatchObject({ locationsResolved: 1, locationsSkippedInvalid: 0, locationsLookupFailed: 0 });
    const body = (upsert.mock.calls[0] as unknown as [UpsertBody])[0];
    expect(body.custom_fields.qcontact_location_gps).toBe("-26.1,28.5");
  });

  it("a resolved location outside South Africa's bounds is not written and counts locationsSkippedInvalid", async () => {
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-x" }));
    const getLocation = vi.fn(async () => ({ id: 500, label: "Loc", fields: { c__latitude: 0, c__longitude: 0 } }));
    await runImport({ qc: qcWithPin("500", []), view: "v", statePath, upsert, getLocation, dryRun: false, log });
    const s = await runImport({ qc: qcWithPin("500", [1]), view: "v", statePath, upsert, getLocation, dryRun: false, log });
    expect(s).toMatchObject({ locationsResolved: 0, locationsSkippedInvalid: 1, locationsLookupFailed: 0 });
    const body = (upsert.mock.calls[0] as unknown as [UpsertBody])[0];
    expect("qcontact_location_gps" in body.custom_fields).toBe(false);
    expect(body.custom_fields.qcontact_location_pin).toBe("500"); // pin id still kept as-is
  });

  it("a 404 on the location lookup still imports the case and counts locationsLookupFailed", async () => {
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-x" }));
    const getLocation = vi.fn(async () => { throw new Error("QContact GET /api/v2/entities/c__contactlocation/500: HTTP 404"); });
    await runImport({ qc: qcWithPin("500", []), view: "v", statePath, upsert, getLocation, dryRun: false, log });
    const s = await runImport({ qc: qcWithPin("500", [1]), view: "v", statePath, upsert, getLocation, dryRun: false, log });
    expect(s).toMatchObject({ sent: 1, failed: 0, locationsResolved: 0, locationsSkippedInvalid: 0, locationsLookupFailed: 1 });
    const body = (upsert.mock.calls[0] as unknown as [UpsertBody])[0];
    expect("qcontact_location_gps" in body.custom_fields).toBe(false);
  });

  it("a case with no pin never calls getLocation and leaves the location counters at 0", async () => {
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-x" }));
    const getLocation = vi.fn(async () => ({ id: 1, label: "Loc", fields: { c__latitude: -26.1, c__longitude: 28.5 } }));
    await runImport({ qc: qcWithPin(undefined, []), view: "v", statePath, upsert, getLocation, dryRun: false, log });
    const s = await runImport({ qc: qcWithPin(undefined, [1]), view: "v", statePath, upsert, getLocation, dryRun: false, log });
    expect(s).toMatchObject({ locationsResolved: 0, locationsSkippedInvalid: 0, locationsLookupFailed: 0 });
    expect(getLocation).not.toHaveBeenCalled();
  });

  it("the same pin shared by two fresh cases in one run is resolved exactly once", async () => {
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-x" }));
    const getLocation = vi.fn(async () => ({ id: 500, label: "Loc", fields: { c__latitude: -26.1, c__longitude: 28.5 } }));
    await runImport({ qc: qcWithPin("500", []), view: "v", statePath, upsert, getLocation, dryRun: false, log });
    const s = await runImport({ qc: qcWithPin("500", [1, 2]), view: "v", statePath, upsert, getLocation, dryRun: false, log });
    expect(s).toMatchObject({ sent: 2, locationsResolved: 1 });
    expect(getLocation).toHaveBeenCalledTimes(1);
  });

  it("no getLocation passed (unset) never resolves a pin, matching pre-existing behaviour", async () => {
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-x" }));
    await runImport({ qc: qcWithPin("500", []), view: "v", statePath, upsert, dryRun: false, log });
    const s = await runImport({ qc: qcWithPin("500", [1]), view: "v", statePath, upsert, dryRun: false, log });
    expect(s).toMatchObject({ locationsResolved: 0, locationsSkippedInvalid: 0, locationsLookupFailed: 0 });
    const body = (upsert.mock.calls[0] as unknown as [UpsertBody])[0];
    expect("qcontact_location_gps" in body.custom_fields).toBe(false);
  });
});

describe("loadState", () => {
  it("a state file with no deals/dealStages key loads and behaves as empty", async () => {
    await writeFile(statePath, JSON.stringify({ seen: [1, 2], updatedAt: "2026-09-01T00:00:00.000Z" }));
    const state = await loadState(statePath);
    expect(state).toEqual({ seen: [1, 2], deals: {}, dealStages: {}, updatedAt: "2026-09-01T00:00:00.000Z" });
  });
});

describe("leadstackUpserter", () => {
  const env = { LEADSTACK_API_URL: "https://crm.test", LEADSTACK_API_KEY: "sk_test" } as Env;
  const body: UpsertBody = { phone: "+27790000001", name: "T", source: "qcontact", tags_add: ["qcontact-install"], custom_fields: { qcontact_case_id: "42" } };

  it("POSTs the body with the bearer key and a per-case idempotency key, returning the contact id", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"contact":{"id":"c_42"}}', { status: 201 }));
    expect(await leadstackUpserter(env, fetchImpl as unknown as typeof fetch)(body)).toEqual({ ok: true, contactId: "c_42" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://crm.test/api/v1/contacts/upsert");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer sk_test",
      "Idempotency-Key": expect.stringMatching(/^qcontact-case-42-[0-9a-f]{12}$/),
    });
    expect(JSON.parse(init.body as string)).toEqual(body);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("gives the same idempotency key for the same body and a different one when the body changes", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"contact":{"id":"c_42"}}', { status: 201 }));
    await leadstackUpserter(env, fetchImpl as unknown as typeof fetch)(body);
    await leadstackUpserter(env, fetchImpl as unknown as typeof fetch)(body);
    await leadstackUpserter(env, fetchImpl as unknown as typeof fetch)({ ...body, name: "Different Name" });
    const keys = fetchImpl.mock.calls.map(
      (c) => ((c as unknown as [string, RequestInit])[1].headers as Record<string, string>)["Idempotency-Key"],
    );
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("reports a 2xx response that isn't JSON as a failure, not a thrown rejection", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json", { status: 201 }));
    const r = await leadstackUpserter(env, fetchImpl as unknown as typeof fetch)(body);
    expect(r).toEqual({ ok: false, error: "upsert 2xx without contact.id" });
  });

  it("reports a 2xx response with no contact.id as a failure", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"contact":{}}', { status: 201 }));
    const r = await leadstackUpserter(env, fetchImpl as unknown as typeof fetch)(body);
    expect(r).toEqual({ ok: false, error: "upsert 2xx without contact.id" });
  });

  it("reports a non-2xx as a failure with the status and body", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"ambiguous_phone"}', { status: 409 }));
    const r = await leadstackUpserter(env, fetchImpl as unknown as typeof fetch)(body);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("HTTP 409") });
  });
});

describe("runImport with syncStage", () => {
  // Seeds a state file that already has cases 1 and 2 marked seen, with the
  // given caseId → dealId / caseId → last-synced-stage maps, mirroring what
  // a prior run's ensureDeal + stage-sync would have written.
  const seedState = (
    deals: Record<string, string>,
    dealStages: Record<string, string> = {},
    seen: number[] = [1, 2],
  ) => saveState(statePath, { seen, deals, dealStages, updatedAt: "" });

  it("syncStage undefined (sync off) makes no HTTP calls and leaves stage counters at 0", async () => {
    await seedState({ "1": "deal-1" });
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-x" }));
    const s = await runImport({ qc: fakeQc([row(1, "2026-09-01", "Assigned")]), view: "v", statePath, upsert, dryRun: false, log });
    expect(s).toMatchObject({ stageSynced: 0, stageUnchanged: 0, stageUnmapped: 0 });
  });

  it("dry-run calls neither upsert nor syncStage, even for a mapped case", async () => {
    await seedState({ "1": "deal-1" });
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-x" }));
    const syncStage: StageSyncer = vi.fn(async () => ({ ok: true as const, action: "patched" as const }));
    const s = await runImport({
      qc: fakeQc([row(1, "2026-09-01", "Assigned")]),
      view: "v", statePath, upsert, syncStage, dryRun: true, log,
    });
    expect(s.mode).toBe("dry-run");
    expect(syncStage).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("only patches cases that have a recorded deal id; an unmapped case is counted and makes no HTTP call", async () => {
    await seedState({ "1": "deal-1" }); // case 2 has no entry
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-x" }));
    const syncStage: StageSyncer = vi.fn(async () => ({ ok: true as const, action: "patched" as const }));
    const s = await runImport({
      qc: fakeQc([row(1, "2026-09-01", "Assigned"), row(2, "2026-09-02", "Assigned")]),
      view: "v", statePath, upsert, syncStage, dryRun: false, log,
    });
    expect(s).toMatchObject({ stageSynced: 1, stageUnmapped: 1 });
    expect(syncStage).toHaveBeenCalledTimes(1);
    expect(syncStage).toHaveBeenCalledWith({ dealId: "deal-1", stage: "assigned" });
  });

  it("moves the deal and records the new stage when it differs from what was last synced", async () => {
    await seedState({ "1": "deal-1" }, { "1": "new" });
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-x" }));
    const syncStage: StageSyncer = vi.fn(async () => ({ ok: true as const, action: "patched" as const }));
    const s = await runImport({
      qc: fakeQc([row(1, "2026-09-01", "Assigned")]),
      view: "v", statePath, upsert, syncStage, dryRun: false, log,
    });
    expect(s).toMatchObject({ stageSynced: 1, stageUnchanged: 0, failed: 0 });
    expect((await loadState(statePath))?.dealStages).toEqual({ "1": "assigned" });
  });

  it("does not call syncStage when the mapped stage already matches the last-synced stage", async () => {
    await seedState({ "1": "deal-1" }, { "1": "assigned" });
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-x" }));
    const syncStage: StageSyncer = vi.fn(async () => ({ ok: true as const, action: "patched" as const }));
    const s = await runImport({
      qc: fakeQc([row(1, "2026-09-01", "Assigned")]),
      view: "v", statePath, upsert, syncStage, dryRun: false, log,
    });
    expect(s).toMatchObject({ stageSynced: 0, stageUnchanged: 1 });
    expect(syncStage).not.toHaveBeenCalled();
  });

  it("counts an unknown status as skipped, without guessing a stage, and makes no HTTP call", async () => {
    await seedState({ "1": "deal-1" });
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-x" }));
    const syncStage: StageSyncer = vi.fn(async () => ({ ok: true as const, action: "patched" as const }));
    const s = await runImport({
      qc: fakeQc([row(1, "2026-09-01", "Some Weird Status")]),
      view: "v", statePath, upsert, syncStage, dryRun: false, log,
    });
    expect(s).toMatchObject({ skipped: { unknown_status: 1 }, failed: 0, stageSynced: 0, stageUnchanged: 0 });
    expect(syncStage).not.toHaveBeenCalled();
  });

  it("a 404 (deal deleted) drops the case from the deals map, counts it, and doesn't fail the run", async () => {
    await seedState({ "1": "deal-1" });
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-x" }));
    const syncStage: StageSyncer = vi.fn(async () => ({ ok: true as const, action: "not_found" as const }));
    const s = await runImport({
      qc: fakeQc([row(1, "2026-09-01", "Assigned")]),
      view: "v", statePath, upsert, syncStage, dryRun: false, log,
    });
    expect(s).toMatchObject({ skipped: { deal_not_found: 1 }, failed: 0, stageSynced: 0 });
    expect((await loadState(statePath))?.deals).toEqual({});
    expect((await loadState(statePath))?.dealStages).toEqual({});
  });

  it("a failed PATCH counts as failed, keeps the mapping, and the loop continues to the next case", async () => {
    await seedState({ "1": "deal-1", "2": "deal-2" });
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-x" }));
    const syncStage = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "HTTP 400 patching deal" })
      .mockResolvedValueOnce({ ok: true, action: "patched" });
    const s = await runImport({
      qc: fakeQc([row(1, "2026-09-01", "Assigned"), row(2, "2026-09-02", "Assigned")]),
      view: "v", statePath, upsert, syncStage, dryRun: false, log,
    });
    expect(s.failed).toBe(1);
    expect(s.stageSynced).toBe(1);
    expect((await loadState(statePath))?.deals).toEqual({ "1": "deal-1", "2": "deal-2" });
  });

  it("stage-sync never marks a case seen/unseen, even on a PATCH failure", async () => {
    await seedState({ "5": "deal-5" }, {}, [5]);
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-x" }));
    const before = (await loadState(statePath))?.seen;
    const syncStage: StageSyncer = vi.fn(async () => ({ ok: false as const, error: "boom" }));
    const s = await runImport({
      qc: fakeQc([row(5, "2026-09-01", "Escalated")]),
      view: "v", statePath, upsert, syncStage, dryRun: false, log,
    });
    expect(s.fresh).toBe(0); // case 5 already seen, not re-sent
    expect((await loadState(statePath))?.seen).toEqual(before); // unchanged despite the syncStage failure
  });

  it("the stage-sync pass never calls upsert, even for already-seen mapped cases", async () => {
    await seedState({ "1": "deal-1", "2": "deal-2" });
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-x" }));
    const syncStage: StageSyncer = vi.fn(async () => ({ ok: true as const, action: "patched" as const }));
    await runImport({
      qc: fakeQc([row(1, "2026-09-01", "Assigned"), row(2, "2026-09-02", "Escalated")]),
      view: "v", statePath, upsert, syncStage, dryRun: false, log,
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("logs the distinct QContact statuses of cases with no recorded deal id, not just a count", async () => {
    await seedState({}, {}, [1, 2, 3]); // none of the seen cases have a deal recorded
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-x" }));
    const syncStage: StageSyncer = vi.fn(async () => ({ ok: true as const, action: "patched" as const }));
    const lines: string[] = [];
    const s = await runImport({
      qc: fakeQc([
        row(1, "2026-09-01", "Solved"),
        row(2, "2026-09-02", "Solved"),
        row(3, "2026-09-03", "In Progress"),
      ]),
      view: "v", statePath, upsert, syncStage, dryRun: false, log: (l) => lines.push(l),
    });
    expect(s.stageUnmapped).toBe(3);
    const summaryLine = lines.find((l) => l.startsWith("stage sync:"));
    expect(summaryLine).toContain("3 case(s) have no recorded deal id");
    expect(summaryLine).toContain("In Progress");
    expect(summaryLine).toContain("Solved");
  });
});

describe("acquireLock", () => {
  let lockPath: string;
  beforeEach(() => {
    lockPath = join(dir, "state.json.lock");
  });

  const setMtime = (path: string, ageMs: number) => {
    const t = new Date(Date.now() - ageMs);
    return utimes(path, t, t);
  };

  it("acquires a fresh lock and the release function removes the lock file", async () => {
    const result = await acquireLock(lockPath);
    if (!result.ok) throw new Error("expected acquireLock to succeed");
    await expect(readFile(lockPath, "utf8")).resolves.toBe(String(process.pid));
    await result.release();
    await expect(readFile(lockPath, "utf8")).rejects.toThrow();
  });

  it("refuses to acquire when the lock is held by a live process, and isn't flagged stale", async () => {
    // process.pid is always alive from this process's own point of view.
    await writeFile(lockPath, String(process.pid));
    const result = await acquireLock(lockPath);
    expect(result).toMatchObject({ ok: false, stale: false });
    await expect(readFile(lockPath, "utf8")).resolves.toBe(String(process.pid)); // untouched
  });

  it("clears a stale lock (owning PID is gone) and acquires it", async () => {
    // PID 999999999 is out of range / essentially guaranteed not to exist.
    await writeFile(lockPath, "999999999");
    const result = await acquireLock(lockPath);
    if (!result.ok) throw new Error("expected acquireLock to succeed");
    await expect(readFile(lockPath, "utf8")).resolves.toBe(String(process.pid));
    await result.release();
  });

  it("treats an unparsable lock file as stale and replaces it", async () => {
    await writeFile(lockPath, "not-a-pid");
    const result = await acquireLock(lockPath);
    if (!result.ok) throw new Error("expected acquireLock to succeed");
    await result.release();
  });

  it("treats an empty lock file as stale rather than a live PID (Number('') is 0, not a valid pid)", async () => {
    await writeFile(lockPath, "");
    const result = await acquireLock(lockPath);
    if (!result.ok) throw new Error("expected acquireLock to succeed");
    await expect(readFile(lockPath, "utf8")).resolves.toBe(String(process.pid));
    await result.release();
  });

  it("rejects pid 0 and negative pids as invalid, not live", async () => {
    await writeFile(lockPath, "0");
    const result = await acquireLock(lockPath);
    expect(result.ok).toBe(true);
  });

  it("flags a refusal as stale once the lock is older than the 1h cap, even with a live-looking pid", async () => {
    await writeFile(lockPath, String(process.pid));
    await setMtime(lockPath, LOCK_STALE_AGE_MS + 60_000);
    const result = await acquireLock(lockPath);
    expect(result).toMatchObject({ ok: false, stale: true });
    if (result.ok) throw new Error("unreachable");
    expect(result.ageMs).toBeGreaterThan(LOCK_STALE_AGE_MS);
    // Refused, not auto-reclaimed — the file is left exactly as it was.
    await expect(readFile(lockPath, "utf8")).resolves.toBe(String(process.pid));
  });

  it("does not flag a refusal as stale when the lock is younger than the cap", async () => {
    await writeFile(lockPath, String(process.pid));
    await setMtime(lockPath, LOCK_STALE_AGE_MS - 60_000);
    const result = await acquireLock(lockPath);
    expect(result).toMatchObject({ ok: false, stale: false });
  });

  it("backs off instead of proceeding if the lock no longer holds our pid right after we wrote it", async () => {
    // Simulates the create-then-write race: another run judges the lock
    // stale off its momentarily-empty content, deletes it, and recreates it
    // with its own pid, between our open() and our own read-back.
    vi.mocked(readFile).mockResolvedValueOnce("999999998" as never);
    const result = await acquireLock(lockPath);
    expect(result).toMatchObject({ ok: false, stale: false });
    // Backing off must not delete what it (falsely, per the mock) believes
    // is someone else's winning lock — acquireLock's back-off path never
    // calls unlink, unlike the "genuinely stale" path.
    await expect(readFile(lockPath, "utf8")).resolves.toBeTypeOf("string");
  });

  it("logs to stderr when a release fails, instead of swallowing it silently", async () => {
    const result = await acquireLock(lockPath);
    if (!result.ok) throw new Error("expected acquireLock to succeed");
    await rm(lockPath); // release's unlink will now fail with ENOENT
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await result.release();
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("failed to release qcontact-import lock"));
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("describeLockRefusal", () => {
  it("routes a stale refusal to stderr with a non-zero exit code", () => {
    const r = describeLockRefusal("/tmp/x.lock", { ok: false, stale: true, ageMs: LOCK_STALE_AGE_MS + 120_000 });
    expect(r.stream).toBe("stderr");
    expect(r.exitCode).toBe(1);
    expect(r.message).toContain("/tmp/x.lock");
    expect(r.message).toContain("still looks held");
  });

  it("routes a normal (non-stale) refusal to stdout with exit code 0", () => {
    const r = describeLockRefusal("/tmp/x.lock", { ok: false, stale: false, ageMs: 5_000 });
    expect(r.stream).toBe("stdout");
    expect(r.exitCode).toBe(0);
    expect(r.message).toContain("already in progress");
  });
});
