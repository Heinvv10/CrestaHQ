import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import type { Quote } from "@/types/quotes";

/**
 * Accepting a quote moves its linked deal to the deal's OWN pipeline's Won
 * stage. When that pipeline has no Won stage the quote must NOT fall back
 * to minting a second, default-pipeline deal — that double-counts revenue.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: async () => ({ enrolled: [], skipped: [], reason: null }),
}));

const { applyDealOutcomeForAcceptedQuote } = await import("./lifecycle");

const quote = (dealId: string): Quote =>
  ({
    id: "q1",
    dealId,
    subAccountId: "sa1",
    agencyId: "ag1",
    createdByUid: "u1",
    contactId: "c1",
    currency: "USD",
    lineItems: [{ id: "i1", name: "Thing", quantity: 1, unitPrice: 100 }],
    globalDiscount: null,
    globalTaxPercent: null,
    autoCreateDealOnAccept: true,
  }) as unknown as Quote;

beforeEach(() => {
  mem.clear();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Ann" });
  mem.seed("subAccounts/sa1/pipelines/won", {
    name: "Renewals", isDefault: false, agencyId: "ag1", subAccountId: "sa1",
    stages: [{ id: "open", label: "Open", tone: "" }, { id: "renewed", label: "Renewed", tone: "", terminal: "won" }],
  });
  mem.seed("subAccounts/sa1/pipelines/nowon", {
    name: "Open only", isDefault: false, agencyId: "ag1", subAccountId: "sa1",
    stages: [{ id: "a", label: "A", tone: "" }],
  });
  const deal = { title: "D", value: 1, currency: "USD", contactId: "c1", subAccountId: "sa1", agencyId: "ag1", mode: "live" };
  mem.seed("deals/d_won", { ...deal, pipelineId: "won", stageId: "open" });
  mem.seed("deals/d_nowon", { ...deal, pipelineId: "nowon", stageId: "a" });
});

describe("applyDealOutcomeForAcceptedQuote", () => {
  it("moves the linked deal to ITS pipeline's won stage and creates nothing", async () => {
    await applyDealOutcomeForAcceptedQuote(quote("d_won"));
    expect(mem.read("deals/d_won")).toMatchObject({ stageId: "renewed", value: 100 });
    expect(mem.list("deals")).toHaveLength(2);
  });

  it("a linked deal whose pipeline has no won stage is left alone — no duplicate deal", async () => {
    await applyDealOutcomeForAcceptedQuote(quote("d_nowon"));
    expect(mem.read("deals/d_nowon")?.stageId).toBe("a");
    expect(mem.list("deals")).toHaveLength(2);
  });

  it("a missing linked deal still falls back to auto-create", async () => {
    await applyDealOutcomeForAcceptedQuote(quote("gone"));
    expect(mem.list("deals")).toHaveLength(3);
  });

  it("both outcomes write a stage-history row: the linked move and the auto-created Won deal", async () => {
    await applyDealOutcomeForAcceptedQuote(quote("d_won"));
    await applyDealOutcomeForAcceptedQuote(quote("gone"));
    const created = mem.list("deals").find((d) => !["d_won", "d_nowon"].includes(d.id))!;
    expect(mem.list("dealStageHistory")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dealId: "d_won", fromStageId: "open", stageId: "renewed", source: "quote", createdByUid: "u1",
        }),
        expect.objectContaining({
          dealId: created.id, fromStageId: null, stageId: "won", pipelineId: "default",
          source: "quote", subAccountId: "sa1", agencyId: "ag1",
        }),
      ]),
    );
    expect(mem.list("dealStageHistory")).toHaveLength(2);
  });

  it("the auto-created deal lands on the default pipeline's Won-flagged stage, whatever its id", async () => {
    mem.seed("subAccounts/sa1/pipelines/default", {
      name: "Default", isDefault: true, agencyId: "ag1", subAccountId: "sa1",
      stages: [
        { id: "new", label: "New", tone: "" },
        { id: "won", label: "Was won, now open", tone: "" },
        { id: "closed", label: "Closed", tone: "", terminal: "won" },
      ],
    });
    await applyDealOutcomeForAcceptedQuote(quote("gone"));
    const created = mem.list("deals").find((d) => !["d_won", "d_nowon"].includes(d.id))!;
    expect(created).toMatchObject({ stageId: "closed" });
    expect(mem.list("contacts/c1/activities")).toEqual([
      expect.objectContaining({ content: expect.stringContaining("created at Closed"), meta: expect.objectContaining({ toStageId: "closed" }) }),
    ]);
  });

  it("no Won stage on the default pipeline: nothing is auto-created", async () => {
    mem.seed("subAccounts/sa1/pipelines/default", {
      name: "Default", isDefault: true, agencyId: "ag1", subAccountId: "sa1",
      stages: [{ id: "new", label: "New", tone: "" }],
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await applyDealOutcomeForAcceptedQuote(quote("gone"));
    expect(mem.list("deals")).toHaveLength(2);
    expect(mem.list("dealStageHistory")).toHaveLength(0);
    // Refused on purpose, by name — not swallowed as a crash.
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("has no won stage"));
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
