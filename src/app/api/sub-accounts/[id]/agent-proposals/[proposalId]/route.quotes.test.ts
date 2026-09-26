import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, beforeNextTransaction, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { QUOTE } from "@/test/quote-fixtures";

/**
 * The PR11 quote capabilities through the real dispatch and decide route:
 * a draft is created through the quotes route's own writer and edited
 * directly (stamped as the agent's); an edit of a quote that is no longer a
 * draft is a spend proposal with every asked field old -> new, re-checked in
 * the write's transaction; ids, products and deals stay in the sub-account.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");

const ANN = { subAccountId: "sa1", agencyId: "ag1", name: "Ann", email: "ann@x.io", territoryId: "global" };
const LINE = { description: "Install", quantity: 2, unitPrice: 250 };
const call = (name: string, args: Record<string, unknown>) => dispatchAgentTool(auth, name, args);
const rowOf = (id: string, label: string) => (row(id).preview as Array<{ label: string; value: string }>).find((r) => r.label === label)?.value;

beforeEach(() => {
  mem.seed("contacts/c1", ANN);
  mem.seed("contacts/c2", { ...ANN, name: "Ben" });
  mem.seed("quotes/q1", QUOTE);
  mem.seed("products/pr1", { subAccountId: "sa1", agencyId: "ag1", name: "Fibre", unitPriceCents: 25000, currency: "ZAR", active: true });
  mem.seed("products/pr_other", { subAccountId: "sa2", agencyId: "ag1", name: "Theirs", unitPriceCents: 1, currency: "ZAR", active: true });
  mem.seed("deals/d1", { subAccountId: "sa1", agencyId: "ag1", title: "Fibre", contactId: "c1", stageId: "new" });
  mem.seed("deals/d_ben", { subAccountId: "sa1", agencyId: "ag1", title: "Other", contactId: "c2", stageId: "new" });
});

describe("create_quote / list_quotes / get_quote", () => {
  it("drafts through the route's writer: numbered, lines numbered, stamped; list and get read it back", async () => {
    const r = await call("create_quote", { contactId: "c1", kind: "invoice", currency: "zar", lineItems: [{ ...LINE, productId: "pr1" }], paymentDueDays: 7 });
    const id = (r as { ref: { id: string } }).ref.id;
    expect(mem.read(`quotes/${id}`)).toMatchObject({
      subAccountId: "sa1", kind: "invoice", status: "draft", contactId: "c1", currency: "ZAR", paymentDueDays: 7, territoryId: "global",
      lineItems: [{ id: "line1", description: "Install", quantity: 2, unitPrice: 250, productId: "pr1" }], lastAgentEditKey: "abcd1234",
    });
    expect(mem.read(`quotes/${id}`)!.quoteNumber).toMatch(/\d/);
    expect(await call("list_quotes", { contactId: "c1" })).toMatchObject({ ok: true, resultText: expect.stringContaining(`id: ${id}, draft, contact c1, ZAR 500`) });
    expect(await call("get_quote", { quoteId: id })).toMatchObject({ ok: true, resultText: expect.stringContaining("2 \u00d7 Install @ ZAR 250 = ZAR 500") });
  });

  it.each([
    ["an invisible character in a line", { lineItems: [{ ...LINE, description: "Install\u200b" }] }, "invalid_args"],
    ["a line with a negative price", { lineItems: [{ ...LINE, unitPrice: -1 }] }, "invalid_args"],
    ["no lines", { lineItems: [] }, "invalid_args"],
    ["a product id that is a path", { lineItems: [{ ...LINE, productId: "pr1/x/y" }] }, "invalid_args"],
    ["a 60% tax", { lineItems: [LINE], globalTaxPercent: 160 }, "invalid_args"],
    ["a control character in the terms", { lineItems: [LINE], termsAndNotes: "Pay\u0007now" }, "invalid_args"],
  ])("%s -> refused, nothing written", async (_label, patch, code) => {
    expect(await call("create_quote", { contactId: "c1", ...patch })).toMatchObject({ ok: false, code });
    expect(mem.list("quotes")).toHaveLength(1);
  });

  it.each([
    ["another sub-account's product", { lineItems: [{ ...LINE, productId: "pr_other" }] }, "A line names a product that isn't in this workspace."],
    ["another contact's deal", { lineItems: [LINE], dealId: "d_ben" }, "Linked deal belongs to a different contact."],
    ["another sub-account's contact", { contactId: "c_other", lineItems: [LINE] }, "That contact isn't in this workspace."],
  ])("%s -> refused, nothing written", async (_label, patch, message) => {
    mem.seed("contacts/c_other", { ...ANN, subAccountId: "sa2" });
    expect(await call("create_quote", { contactId: "c1", ...patch })).toMatchObject({ ok: false, message });
    expect(mem.list("quotes")).toHaveLength(1);
  });

  it("the multi-line terms keep their line breaks", async () => {
    const r = await call("create_quote", { contactId: "c1", lineItems: [LINE], termsAndNotes: "Line one\nLine two", dealId: "d1" });
    expect(mem.read(`quotes/${(r as { ref: { id: string } }).ref.id}`)).toMatchObject({ termsAndNotes: "Line one\nLine two", dealId: "d1" });
  });
});

describe("update_quote", () => {
  it("a draft: written directly, stamped", async () => {
    expect(await call("update_quote", { quoteId: "q1", lineItems: [LINE], globalTaxPercent: 15 })).toMatchObject({ ok: true });
    expect(mem.read("quotes/q1")).toMatchObject({ lineItems: [{ id: "line1", ...LINE, productId: null }], globalTaxPercent: 15, lastAgentEditKey: "abcd1234" });
  });

  it("a sent quote: a spend proposal, old -> new and the total, nothing written; approve applies it", async () => {
    mem.seed("quotes/q1", { ...QUOTE, status: "sent" });
    const r = await call("update_quote", { quoteId: "q1", lineItems: [LINE], globalTaxPercent: 15, termsAndNotes: "Due on install" });
    const id = (r as { proposal: { id: string } }).proposal.id;
    expect(row(id).approval).toBe("spend");
    expect(rowOf(id, "Line items now")).toBe("1 \u00d7 Install @ ZAR 500 = ZAR 500");
    expect(rowOf(id, "Line items after")).toBe("2 \u00d7 Install @ ZAR 250 = ZAR 500");
    expect(rowOf(id, "globalTaxPercent")).toBe("(none) \u2192 15%");
    expect(rowOf(id, "termsAndNotes")).toBe("(none) \u2192 Due on install");
    expect(rowOf(id, "Total")).toBe("ZAR 500 \u2192 ZAR 575, including ZAR 75 tax");
    expect(mem.read("quotes/q1")!.globalTaxPercent).toBeNull();
    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read("quotes/q1")).toMatchObject({ globalTaxPercent: 15, termsAndNotes: "Due on install" });
    // The approver made this write, as for every approved action.
    expect(mem.read("quotes/q1")).not.toHaveProperty("lastAgentEditKey");
  });

  it.each([
    ["a pay URL on the invoice", () => mem.seed("quotes/q1", { ...QUOTE, kind: "invoice", status: "sent", paymentLinkUrl: "https://app.example/pay/link/t", paymentLinkId: "pl1" })],
    ["an open Paystack link for it", () => (mem.seed("quotes/q1", { ...QUOTE, kind: "invoice", status: "sent" }), mem.seed("paymentLinks/pl1", { subAccountId: "sa1", invoiceId: "q1", status: "open", active: true }))],
  ])("a price change while %s is live -> refused, no proposal", async (_label, arrange) => {
    arrange();
    expect(await call("update_quote", { quoteId: "q1", globalTaxPercent: 15 })).toMatchObject({
      ok: false, message: "This invoice's emailed pay link charges the old amount; void it and send a new invoice.",
    });
    expect(mem.list("agentProposals")).toEqual([]);
  });

  it.each([
    ["the terms", { termsAndNotes: "Due on install" }],
    ["the lines, with the same total", { lineItems: [LINE] }],
  ])("with a live pay link, changing %s is still a spend proposal", async (_label, patch) => {
    mem.seed("quotes/q1", { ...QUOTE, kind: "invoice", status: "sent", paymentLinkUrl: "https://app.example/pay/link/t", paymentLinkId: "pl1" });
    expect(await call("update_quote", { quoteId: "q1", ...patch })).toMatchObject({ ok: true, proposal: { status: "pending" } });
  });

  it("a draft price change when a pay link is minted inside the write -> refused, unchanged", async () => {
    mem.seed("quotes/q1", { ...QUOTE, kind: "invoice" });
    beforeNextTransaction(async () => mem.seed("paymentLinks/pl1", { subAccountId: "sa1", invoiceId: "q1", status: "open", active: true }));
    expect(await call("update_quote", { quoteId: "q1", globalTaxPercent: 15 })).toMatchObject({ ok: false, message: "This invoice's emailed pay link charges the old amount; void it and send a new invoice." });
    expect(mem.read("quotes/q1")!.globalTaxPercent).toBeNull();
  });

  it("a sent quote edited by someone inside the approved write's window -> failed, unchanged", async () => {
    mem.seed("quotes/q1", { ...QUOTE, status: "sent" });
    const id = ((await call("update_quote", { quoteId: "q1", globalTaxPercent: 15 })) as { proposal: { id: string } }).proposal.id;
    beforeNextTransaction(async () => beforeNextTransaction(async () => mem.seed("quotes/q1", { ...QUOTE, status: "sent", globalTaxPercent: 5 })));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(mem.read("quotes/q1")!.globalTaxPercent).toBe(5);
  });

  it("a draft sent between the agent's read and its write -> refused, unchanged", async () => {
    beforeNextTransaction(async () => mem.seed("quotes/q1", { ...QUOTE, status: "sent" }));
    expect(await call("update_quote", { quoteId: "q1", globalTaxPercent: 15 })).toMatchObject({
      ok: false, message: "It is no longer a draft, so this edit needs approval: send it again.",
    });
    expect(mem.read("quotes/q1")!.globalTaxPercent).toBeNull();
  });

  it.each([
    ["a paid invoice", { status: "paid", kind: "invoice" }, "That invoice is already paid."],
    ["another sub-account's quote", { subAccountId: "sa2" }, "That quote or invoice isn't in this workspace."],
  ])("%s -> refused", async (_label, patch, message) => {
    mem.seed("quotes/q1", { ...QUOTE, ...patch });
    expect(await call("update_quote", { quoteId: "q1", globalTaxPercent: 15 })).toMatchObject({ ok: false, message });
  });

  it.each([
    ["fresh", 60_000, false],
    ["past its TTL", 11 * 60_000, true],
  ])("a draft whose send claim is %s: edited = %s", async (_label, age, edited) => {
    mem.seed("quotes/q1", { ...QUOTE, sendingClaim: { id: "c", at: Date.now() - age, fingerprint: "x" } });
    const r = await call("update_quote", { quoteId: "q1", globalTaxPercent: 15 });
    expect(r).toMatchObject(edited ? { ok: true } : { ok: false, message: "It is being sent right now, so it wasn't changed; try again in a minute." });
    expect(mem.read("quotes/q1")!.globalTaxPercent).toBe(edited ? 15 : null);
  });

  it("nothing to change / a path id -> invalid args", async () => {
    expect(await call("update_quote", { quoteId: "q1" })).toMatchObject({ ok: false, code: "invalid_args" });
    expect(await call("update_quote", { quoteId: "q1/x/y", globalTaxPercent: 1 })).toMatchObject({ ok: false, code: "invalid_args" });
  });
});
