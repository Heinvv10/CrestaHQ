import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leadstackUpserter, loadState, runImport, type Env } from "./run.ts";
import type { CaseDetail, CaseRow, ContactDetail } from "./qcontact.ts";
import type { UpsertBody } from "./map.ts";
import type { DealEnsurer } from "./deals.ts";

const row = (id: number, created: string): CaseRow =>
  ({ id, label: `FT${id}`, created_at: created, status: "New", category: "New Installation" });

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

  it("calls ensureDeal with the upserted contact id, case id and a title built from name + case ref", async () => {
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-2" }));
    const ensureDeal: DealEnsurer = vi.fn(async () => ({ ok: true as const }));
    await runImport({ qc: fakeQc([]), view: "v", statePath, upsert, ensureDeal, dryRun: false, log });
    const s = await runImport({ qc: fakeQc([row(2, "2026-09-02")]), view: "v", statePath, upsert, ensureDeal, dryRun: false, log });
    expect(s).toMatchObject({ sent: 1, failed: 0 });
    expect(ensureDeal).toHaveBeenCalledWith({
      contactId: "contact-2",
      caseId: 2,
      title: "Install request — Test Person (FT2)",
    });
    expect((await loadState(statePath))?.seen).toEqual([2]);
  });

  it("a failed deal step leaves the case unseen and counts it failed, even though the upsert succeeded", async () => {
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-2" }));
    const ensureDeal: DealEnsurer = vi.fn(async () => ({ ok: false, error: "HTTP 500 creating deal" }));
    await runImport({ qc: fakeQc([]), view: "v", statePath, upsert, ensureDeal, dryRun: false, log });
    const s = await runImport({ qc: fakeQc([row(2, "2026-09-02")]), view: "v", statePath, upsert, ensureDeal, dryRun: false, log });
    expect(s).toMatchObject({ sent: 0, failed: 1 });
    expect((await loadState(statePath))?.seen).toEqual([]);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("dry-run never calls ensureDeal", async () => {
    const upsert = vi.fn(async () => ({ ok: true as const, contactId: "contact-2" }));
    const ensureDeal: DealEnsurer = vi.fn(async () => ({ ok: true as const }));
    await runImport({ qc: fakeQc([]), view: "v", statePath, upsert, ensureDeal, dryRun: false, log });
    const s = await runImport({ qc: fakeQc([row(2, "2026-09-02")]), view: "v", statePath, upsert, ensureDeal, dryRun: true, log });
    expect(s).toMatchObject({ mode: "dry-run", sent: 1 });
    expect(ensureDeal).not.toHaveBeenCalled();
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
    expect(init.headers).toMatchObject({ Authorization: "Bearer sk_test", "Idempotency-Key": "qcontact-case-42" });
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it("reports a non-2xx as a failure with the status and body", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"ambiguous_phone"}', { status: 409 }));
    const r = await leadstackUpserter(env, fetchImpl as unknown as typeof fetch)(body);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("HTTP 409") });
  });
});
