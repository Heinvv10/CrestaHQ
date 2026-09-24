import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBackfill, leadstackContactFinder, type CaseContactMatch } from "./backfill.ts";
import { loadState, saveState, type State } from "./run.ts";
import type { CaseRow } from "./qcontact.ts";
import type { DealResult } from "./deals.ts";

type EnsureDealInput = { contactId: string; caseId: number; title: string; stage: string };

const row = (id: number, status: string | null): CaseRow =>
  ({ id, label: `FT${id}`, created_at: "2026-01-01", status, category: "New Installation" });

let dir: string;
let statePath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "qc-backfill-"));
  statePath = join(dir, "state.json");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function seedState(overrides: Partial<State> = {}): Promise<void> {
  await saveState(statePath, {
    seen: [],
    deals: {},
    dealStages: {},
    updatedAt: "",
    ...overrides,
  });
}

const log = () => {};

function fakeFindContacts(matches: Record<string, CaseContactMatch>) {
  return vi.fn(async (caseIds: string[]) => {
    const found = new Map<string, CaseContactMatch>();
    for (const id of caseIds) if (matches[id]) found.set(id, matches[id]);
    return found;
  });
}

describe("runBackfill", () => {
  it("dry-run writes nothing and never calls ensureDeal", async () => {
    await seedState({ seen: [101], deals: {} });
    const findContacts = fakeFindContacts({ "101": { contactId: "c1", name: "Test Person", caseRef: "FT101" } });
    const ensureDeal = vi.fn(async (): Promise<DealResult> => ({ ok: true, dealId: "d1" }));

    const s = await runBackfill({
      qc: { listView: vi.fn(async () => [row(101, "New")]) },
      view: "v", statePath, findContacts, ensureDeal, dryRun: true, log,
    });

    expect(s).toMatchObject({ mode: "dry-run", candidates: 1, created: 1, failed: 0 });
    expect(ensureDeal).not.toHaveBeenCalled();
    expect((await loadState(statePath))?.deals).toEqual({});
  });

  it("apply creates a deal exactly once per candidate and records it", async () => {
    await seedState({ seen: [101, 102], deals: {} });
    const findContacts = fakeFindContacts({
      "101": { contactId: "c1", name: "Person A", caseRef: "FT101" },
      "102": { contactId: "c2", name: "Person B", caseRef: "FT102" },
    });
    const ensureDeal = vi.fn(async ({ contactId }: EnsureDealInput): Promise<DealResult> => ({
      ok: true,
      dealId: `deal-for-${contactId}`,
    }));

    const s = await runBackfill({
      qc: { listView: vi.fn(async () => [row(101, "New"), row(102, "In Progress")]) },
      view: "v", statePath, findContacts, ensureDeal, dryRun: false, log,
    });

    expect(s).toMatchObject({ mode: "apply", candidates: 2, created: 2, failed: 0 });
    expect(ensureDeal).toHaveBeenCalledTimes(2);
    expect(ensureDeal.mock.calls.map((c) => c[0].stage)).toEqual(["new", "in_progress"]);
    const state = await loadState(statePath);
    expect(state?.deals).toEqual({ "101": "deal-for-c1", "102": "deal-for-c2" });
  });

  it("re-running after a successful apply creates none the second time", async () => {
    await seedState({ seen: [101], deals: {} });
    const findContacts = fakeFindContacts({ "101": { contactId: "c1", name: "Person A", caseRef: "FT101" } });
    const ensureDeal = vi.fn(async (): Promise<DealResult> => ({ ok: true, dealId: "d1" }));
    const qc = { listView: vi.fn(async () => [row(101, "New")]) };

    await runBackfill({ qc, view: "v", statePath, findContacts, ensureDeal, dryRun: false, log });
    const second = await runBackfill({ qc, view: "v", statePath, findContacts, ensureDeal, dryRun: false, log });

    expect(second).toMatchObject({ candidates: 0, created: 0 });
    expect(ensureDeal).toHaveBeenCalledTimes(1);
  });

  it("an unrecognised status is reported, not guessed, and never calls ensureDeal", async () => {
    await seedState({ seen: [101], deals: {} });
    const findContacts = fakeFindContacts({ "101": { contactId: "c1", name: "Person A", caseRef: "FT101" } });
    const ensureDeal = vi.fn(async (): Promise<DealResult> => ({ ok: true, dealId: "d1" }));

    const s = await runBackfill({
      qc: { listView: vi.fn(async () => [row(101, "Some New QContact Status")]) },
      view: "v", statePath, findContacts, ensureDeal, dryRun: false, log,
    });

    expect(s).toMatchObject({ candidates: 1, unmappedStatus: 1, created: 0 });
    expect(ensureDeal).not.toHaveBeenCalled();
    expect((await loadState(statePath))?.deals).toEqual({});
  });

  it("a candidate no longer in the current view is reported, not guessed", async () => {
    await seedState({ seen: [101], deals: {} });
    const findContacts = fakeFindContacts({});
    const ensureDeal = vi.fn(async (): Promise<DealResult> => ({ ok: true, dealId: "d1" }));

    const s = await runBackfill({
      qc: { listView: vi.fn(async () => []) },
      view: "v", statePath, findContacts, ensureDeal, dryRun: false, log,
    });

    expect(s).toMatchObject({ candidates: 1, notInView: 1, created: 0 });
    expect(ensureDeal).not.toHaveBeenCalled();
  });

  it("a case with no matching LeadStack contact is reported, not guessed", async () => {
    await seedState({ seen: [101], deals: {} });
    const findContacts = fakeFindContacts({});
    const ensureDeal = vi.fn(async (): Promise<DealResult> => ({ ok: true, dealId: "d1" }));

    const s = await runBackfill({
      qc: { listView: vi.fn(async () => [row(101, "New")]) },
      view: "v", statePath, findContacts, ensureDeal, dryRun: false, log,
    });

    expect(s).toMatchObject({ candidates: 1, contactNotFound: 1, created: 0 });
    expect(ensureDeal).not.toHaveBeenCalled();
  });

  it("a case already recorded in the deals map is not a candidate", async () => {
    await seedState({ seen: [101, 102], deals: { "101": "existing-deal" } });
    const findContacts = fakeFindContacts({ "102": { contactId: "c2", name: "Person B", caseRef: "FT102" } });
    const ensureDeal = vi.fn(async (_input: EnsureDealInput): Promise<DealResult> => ({ ok: true, dealId: "d2" }));

    const s = await runBackfill({
      qc: { listView: vi.fn(async () => [row(101, "New"), row(102, "New")]) },
      view: "v", statePath, findContacts, ensureDeal, dryRun: false, log,
    });

    expect(s).toMatchObject({ candidates: 1, created: 1 });
    expect(ensureDeal).toHaveBeenCalledTimes(1);
    expect(ensureDeal.mock.calls[0][0].contactId).toBe("c2");
  });

  it("a failed deal-create is not recorded, so the next run retries it", async () => {
    await seedState({ seen: [101], deals: {} });
    const findContacts = fakeFindContacts({ "101": { contactId: "c1", name: "Person A", caseRef: "FT101" } });
    const ensureDeal = vi.fn(async (): Promise<DealResult> => ({ ok: false, error: "HTTP 500" }));

    const s = await runBackfill({
      qc: { listView: vi.fn(async () => [row(101, "New")]) },
      view: "v", statePath, findContacts, ensureDeal, dryRun: false, log,
    });

    expect(s).toMatchObject({ candidates: 1, created: 0, failed: 1 });
    expect((await loadState(statePath))?.deals).toEqual({});
  });

  it("throws when no state file exists yet, rather than treating everything as a candidate", async () => {
    const findContacts = fakeFindContacts({});
    const ensureDeal = vi.fn(async (): Promise<DealResult> => ({ ok: true, dealId: "d1" }));
    await expect(
      runBackfill({
        qc: { listView: vi.fn(async () => []) },
        view: "v", statePath, findContacts, ensureDeal, dryRun: false, log,
      }),
    ).rejects.toThrow(/No state file/);
  });
});

describe("leadstackContactFinder", () => {
  it("paginates until every requested case id is found, matching on custom_fields.qcontact_case_id", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              { id: "c1", name: "A", custom_fields: { qcontact_case_id: "101", qcontact_case_ref: "FT101" } },
              { id: "c2", name: "B", custom_fields: { qcontact_case_id: "999" } },
            ],
            has_more: true,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: "c3", name: "C", custom_fields: { qcontact_case_id: "102" } }],
            has_more: true,
          }),
          { status: 200 },
        ),
      );
    const find = leadstackContactFinder(
      { LEADSTACK_API_URL: "https://crm.test", LEADSTACK_API_KEY: "sk_test" },
      fetchImpl as unknown as typeof fetch,
    );

    const found = await find(["101", "102"]);

    expect(found.get("101")).toEqual({ contactId: "c1", name: "A", caseRef: "FT101" });
    expect(found.get("102")).toEqual({ contactId: "c3", name: "C", caseRef: undefined });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stops paginating once the list runs out, even if some ids were never found", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 }),
    );
    const find = leadstackContactFinder(
      { LEADSTACK_API_URL: "https://crm.test", LEADSTACK_API_KEY: "sk_test" },
      fetchImpl as unknown as typeof fetch,
    );

    const found = await find(["101"]);

    expect(found.size).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
