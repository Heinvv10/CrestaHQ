import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, beforeNextTransaction, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * The PR10 product, snippet and WhatsApp-template capabilities through the
 * real dispatch and decide route: a product a checkout page or funnel sells
 * can't be deleted; a snippet is stamped as the agent's and its delete shows
 * the text; hidden text is refused; every id stays in the sub-account.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");

const PRODUCT = { subAccountId: "sa1", agencyId: "ag1", name: "Fibre 100", description: "", unitPriceCents: 49900, currency: "ZAR", active: true };
const SNIPPET = { subAccountId: "sa1", agencyId: "ag1", name: "Thanks", type: "text", body: "Thanks!\nSee you soon.", subject: null, folder: null };
const call = (name: string, args: Record<string, unknown>) => dispatchAgentTool(auth, name, args);
async function proposeId(name: string, args: Record<string, unknown>): Promise<string> {
  const r = await call(name, args);
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}
const page = (patch: Record<string, unknown>) =>
  mem.seed("subAccounts/sa1/checkoutPages/cp1", { subAccountId: "sa1", productId: "other", bumpProductIds: [], ...patch });

beforeEach(() => {
  mem.seed("products/pr1", PRODUCT);
  mem.seed("snippets/sn1", SNIPPET);
});

describe("products", () => {
  it("create / update write through the products route's sanitizer, stamped", async () => {
    const r = await call("create_product", { name: "Fibre 200", unitPriceCents: 69900, currency: "zar" });
    const id = (r as { ref: { id: string } }).ref.id;
    expect(mem.read(`products/${id}`)).toMatchObject({ name: "Fibre 200", unitPriceCents: 69900, currency: "ZAR", active: true, lastAgentEditKey: "abcd1234" });
    expect(await call("update_product", { productId: "pr1", unitPriceCents: 59900 })).toMatchObject({ ok: true });
    expect(mem.read("products/pr1")).toMatchObject({ unitPriceCents: 59900, lastAgentEditKey: "abcd1234" });
  });

  it.each([
    ["an invisible character in the name", "create_product", { name: "Fibre\u200b", unitPriceCents: 1 }],
    ["a negative price", "create_product", { name: "Fibre", unitPriceCents: -1 }],
    ["a price as text", "update_product", { productId: "pr1", unitPriceCents: "100" }],
    ["a 4-letter currency", "update_product", { productId: "pr1", currency: "RAND" }],
    ["an invisible character in the description", "update_product", { productId: "pr1", description: "Fast\u200b" }],
    ["nothing to change", "update_product", { productId: "pr1" }],
    ["an id that is a path", "update_product", { productId: "pr1/x/y", name: "X" }],
  ])("%s → refused", async (_label, name, args) => {
    expect(await call(name, args)).toMatchObject({ ok: false, code: "invalid_args" });
    expect(mem.read("products/pr1")).toEqual(PRODUCT);
  });

  it("a price change to a product a checkout page sells → a spend proposal naming it, nothing written; approve applies", async () => {
    page({ productId: "pr1", name: "Main offer" });
    const id = await proposeId("update_product", { productId: "pr1", unitPriceCents: 59900 });
    expect(row(id).approval).toBe("spend");
    expect(row(id).preview).toEqual(expect.arrayContaining([
      { label: "Price", value: "ZAR 499 → ZAR 599" },
      { label: "Sold by", value: "checkout page Main offer (cp1)" },
    ]));
    expect(JSON.stringify(row(id).preview)).not.toContain('"Active"');
    expect(mem.read("products/pr1")!.unitPriceCents).toBe(49900);
    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read("products/pr1")!.unitPriceCents).toBe(59900);
  });

  it.each([
    ["deactivating a product a funnel sells", () => mem.seed("subAccounts/sa1/funnels/fu1", { subAccountId: "sa1", productId: "pr1", name: "Promo" }), { active: false }],
    ["a currency change to an order bump", () => page({ bumpProductIds: ["pr1"] }), { currency: "USD" }],
  ])("%s → a spend proposal", async (_label, arrange, patch) => {
    arrange();
    expect(await call("update_product", { productId: "pr1", ...patch })).toMatchObject({ ok: true, proposal: { status: "pending" } });
    expect(mem.read("products/pr1")).toEqual(PRODUCT);
  });

  it("any edit of a sold product (what its checkout shows) → a spend proposal with every asked field old → new", async () => {
    page({ productId: "pr1" });
    mem.seed("products/pr1", { ...PRODUCT, bumpEligible: true, bumpHeadline: "Add speed" });
    const id = await proposeId("update_product", { productId: "pr1", name: "Fibre 100 Pro", description: "Now faster", bumpHeadline: "Add more speed", bumpEligible: false, active: true });
    expect(row(id).approval).toBe("spend");
    expect(row(id).preview).toEqual(expect.arrayContaining([
      { label: "Name", value: "Fibre 100 → Fibre 100 Pro" },
      { label: "Description", value: "(none) → Now faster" },
      { label: "Bump headline", value: "Add speed → Add more speed" },
      { label: "Offered as an order bump", value: "true → false" },
      { label: "Active", value: "true (unchanged)" },
    ]));
    expect(mem.read("products/pr1")).toMatchObject({ name: "Fibre 100", bumpEligible: true });
    // A field the edit touches changed since review → refused, nothing written.
    beforeNextTransaction(async () => mem.seed("products/pr1", { ...PRODUCT, bumpEligible: true, bumpHeadline: "Changed" }));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(mem.read("products/pr1")!.name).toBe("Fibre 100");
  });

  it.each([
    ["a rename", { name: "Fibre 100 Pro" }],
    ["a new description", { description: "Now faster" }],
    ["a new bump headline", { bumpHeadline: "Add speed" }],
    ["dropping it as an order bump", { bumpEligible: false }],
  ])("%s alone on a sold product → a spend proposal", async (_label, patch) => {
    page({ productId: "pr1" });
    expect(await call("update_product", { productId: "pr1", ...patch })).toMatchObject({ ok: true, proposal: { status: "pending" } });
    expect(mem.read("products/pr1")).toEqual(PRODUCT);
  });

  it("a price change to an unsold product is a direct write", async () => {
    mem.seed("products/pr2", { ...PRODUCT, name: "Unsold" });
    expect(await call("update_product", { productId: "pr2", unitPriceCents: 1 })).toMatchObject({ ok: true, resultText: "Updated the product." });
    expect(mem.read("products/pr2")!.unitPriceCents).toBe(1);
  });

  it("a checkout page starting to sell it between the check and the direct write → refused, nothing written", async () => {
    beforeNextTransaction(async () => page({ productId: "pr1" }));
    expect(await call("update_product", { productId: "pr1", unitPriceCents: 1 })).toMatchObject({
      ok: false, message: "A checkout page or funnel now sells this product, so this change needs approval: send it again.",
    });
    expect(mem.read("products/pr1")).toEqual(PRODUCT);
  });

  it("the price changed between the approve-time re-check and the write → failed, nothing written", async () => {
    page({ productId: "pr1" });
    const id = await proposeId("update_product", { productId: "pr1", unitPriceCents: 59900 });
    beforeNextTransaction(async () => mem.seed("products/pr1", { ...PRODUCT, unitPriceCents: 1 }));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id).error).toBe("The product changed since this was reviewed; nothing was changed.");
    expect(mem.read("products/pr1")!.unitPriceCents).toBe(1);
  });

  it("a currency-only edit pins the amount too: the amount changing in the window → failed", async () => {
    page({ productId: "pr1" });
    const id = await proposeId("update_product", { productId: "pr1", currency: "USD" });
    expect(row(id).pinned).toEqual({ productId: "pr1", before: { currency: "ZAR", unitPriceCents: 49900 } });
    beforeNextTransaction(async () => mem.seed("products/pr1", { ...PRODUCT, unitPriceCents: 1 }));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(mem.read("products/pr1")!.currency).toBe("ZAR");
  });

  it.each([
    ["a Cyrillic e", "create_product", { name: "Fibr\u0435 100", unitPriceCents: 1 }, "the name mixes Latin with Cyrillic or Greek letters in one word"],
    ["l and O for 1 and 0 (as another product's)", "create_product", { name: "Fibre lOO", unitPriceCents: 1 }, "The name is the same as, or looks like, an existing one (another product's)."],
    ["another product's name on update", "update_product", { productId: "pr2", name: "FIBRE 100" }, "The name is the same as, or looks like, an existing one (another product's)."],
  ])("a product name with %s → refused", async (_label, name, args, message) => {
    mem.seed("products/pr2", { ...PRODUCT, name: "Unsold" });
    expect(await call(name, args)).toMatchObject({ ok: false, message });
    expect(await call("update_product", { productId: "pr1", name: "Fibre 100" })).toMatchObject({ ok: true });
  });

  it.each([
    ["a checkout page's offer", () => page({ productId: "pr1" })],
    ["a checkout page's order bump", () => page({ bumpProductIds: ["pr1"] })],
    ["a funnel", () => mem.seed("subAccounts/sa1/funnels/fu1", { subAccountId: "sa1", productId: "pr1" })],
  ])("delete_product of a product sold by %s → refused at propose", async (_label, arrange) => {
    arrange();
    expect(await call("delete_product", { productId: "pr1" })).toMatchObject({ ok: false, message: expect.stringContaining("deleting it would break them") });
    expect(mem.list("agentProposals")).toEqual([]);
  });

  it("delete_product → a proposal counting open quotes; approve deletes; a checkout page added in the window → failed", async () => {
    mem.seed("quotes/q1", { subAccountId: "sa1", status: "sent", lineItems: [{ productId: "pr1" }] });
    mem.seed("quotes/q2", { subAccountId: "sa1", status: "paid", lineItems: [{ productId: "pr1" }] });
    mem.seed("quotes/q3", { subAccountId: "sa2", status: "sent", lineItems: [{ productId: "pr1" }] });
    const id = await proposeId("delete_product", { productId: "pr1" });
    expect(row(id).preview).toContainEqual({ label: "Open quotes / invoices using it", value: "1 (they keep their own copy of name and price)" });
    beforeNextTransaction(async () => page({ productId: "pr1" }));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id).error).toBe("A checkout page or funnel now sells this product; it was not deleted.");
    expect(mem.read("products/pr1")).toBeDefined();
    mem.seed("subAccounts/sa1/checkoutPages/cp1", { subAccountId: "sa1", productId: "other", bumpProductIds: [] });
    const id2 = await proposeId("delete_product", { productId: "pr1" });
    expect((await decide(id2, "approve")).status).toBe(200);
    expect(mem.read("products/pr1")).toBeUndefined();
  });

  it("a checkout page appearing inside the delete's own transaction → refused, product kept", async () => {
    const id = await proposeId("delete_product", { productId: "pr1" });
    // After approve's claim, then as the delete's transaction starts.
    beforeNextTransaction(async () => beforeNextTransaction(async () => page({ productId: "pr1" })));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(mem.read("products/pr1")).toBeDefined();
  });

  it("another sub-account's product isn't found", async () => {
    mem.seed("products/pr9", { ...PRODUCT, subAccountId: "sa2" });
    expect(await call("update_product", { productId: "pr9", name: "X" })).toMatchObject({ ok: false, message: "That product isn't in this workspace." });
    expect(await call("delete_product", { productId: "pr9" })).toMatchObject({ ok: false });
    expect(JSON.stringify(await call("list_products", {}))).not.toContain("pr9");
  });
});

describe("snippets", () => {
  it("create / update keep line breaks and are stamped as the agent's", async () => {
    const r = await call("create_snippet", { name: "Welcome", type: "email", subject: "Hi", body: "Hello {{contact.firstName}},\nWelcome!" });
    const id = (r as { ref: { id: string } }).ref.id;
    expect(mem.read(`snippets/${id}`)).toMatchObject({ body: "Hello {{contact.firstName}},\nWelcome!", subject: "Hi", lastAgentEditKey: "abcd1234" });
    expect(await call("update_snippet", { snippetId: "sn1", name: "Thanks", type: "text", body: "Thank you!" })).toMatchObject({ ok: true });
    expect(mem.read("snippets/sn1")).toMatchObject({ body: "Thank you!", lastAgentEditKey: "abcd1234" });
  });

  it.each([
    ["an invisible character in the body", { name: "X", type: "text", body: "Hi\u200bthere" }],
    ["an invisible character in the name", { name: "X\u200b", type: "text", body: "Hi" }],
    ["an invisible character in the subject", { name: "X", type: "email", subject: "S\u200b", body: "Hi" }],
    ["an email with no subject", { name: "X", type: "email", body: "Hi" }],
  ])("create_snippet with %s → refused", async (_label, args) => {
    expect(await call("create_snippet", args)).toMatchObject({ ok: false, code: "invalid_args" });
  });

  it.each([
    ["a word mixing Latin and Cyrillic", { name: "B\u0430nk details" }, "the name mixes Latin with Cyrillic or Greek letters in one word"],
  ])("a snippet name with %s → refused", async (_label, patch, message) => {
    expect(await call("create_snippet", { type: "text", body: "Hi", ...patch })).toMatchObject({ ok: false, code: "invalid_args", message });
  });

  it.each([
    ["an l for an I", "lnvoice link", "The name is the same as, or looks like, an existing one (another snippet's)."],
    ["rn for m", "Payrnent link", "The name is the same as, or looks like, an existing one (another snippet's)."],
    ["vv for w", "VVelcome", "The name is the same as, or looks like, an existing one (another snippet's)."],
    ["all-Cyrillic look-alikes", "\u0422\u0410\u0425 INFO", "the name uses letters from another script that look like Latin ones"],
    ["all-Greek look-alikes", "\u03a4\u0391\u03a7 INFO", "the name uses letters from another script that look like Latin ones"],
    ["an Armenian o", "B\u0585nus code", "the name uses letters from another script that look like Latin ones"],
    ["a Cherokee S", "\u13daMS reply", "the name uses letters from another script that look like Latin ones"],
  ])("a snippet name with %s → refused", async (_label, name, message) => {
    mem.seed("snippets/sn2", { ...SNIPPET, name: "Invoice link" });
    mem.seed("snippets/sn3", { ...SNIPPET, name: "Payment link" });
    mem.seed("snippets/sn4", { ...SNIPPET, name: "Welcome" });
    expect(await call("create_snippet", { name, type: "text", body: "Hi" })).toMatchObject({ ok: false, message });
  });

  it("a snippet name matching another's once normalised → refused; one wholly in Cyrillic or Greek is fine", async () => {
    expect(await call("create_snippet", { name: " thanks ", type: "text", body: "Hi" })).toMatchObject({
      ok: false, message: "The name is the same as, or looks like, an existing one (another snippet's).",
    });
    for (const name of ["\u0411\u0430\u043d\u043a", "\u03a4\u03c1\u03ac\u03c0\u03b5\u03b6\u03b1"]) {
      expect(await call("create_snippet", { name, type: "text", body: "Hi" })).toMatchObject({ ok: true });
    }
  });

  it("ordinary names in other languages and scripts are accepted", async () => {
    for (const name of ["Stra\u00dfe", "Caf\u00e9 cr\u00e8me", "Nguy\u1ec5n", "Zo\u00eb", "fa\u00e7ade", "O'Brien", "\u041c\u043e\u0441\u043a\u0432\u0430 office", "\u0391\u03b8\u03ae\u03bd\u03b1 branch", "\u65e5\u672c office", "\u00b5-controller", "\u0394-value"] as const) {
      expect(await call("create_snippet", { name, type: "text", body: "Hi" }), name).toMatchObject({ ok: true });
    }
  });

  it("update_snippet to another snippet's name is refused; another sub-account's same name doesn't count", async () => {
    mem.seed("snippets/sn2", { ...SNIPPET, name: "Welcome" });
    expect(await call("update_snippet", { snippetId: "sn1", name: "welcome", type: "text", body: "Hi" })).toMatchObject({
      ok: false, message: "The name is the same as, or looks like, an existing one (another snippet's).",
    });
    mem.seed("snippets/sn9", { ...SNIPPET, subAccountId: "sa2", name: "Pricing" });
    expect(await call("create_snippet", { name: "Pricing", type: "text", body: "Hi" })).toMatchObject({ ok: true });
  });

  it("an invisible character in the body is refused as such (not as a missing body)", async () => {
    expect(await call("create_snippet", { name: "X", type: "text", body: "Hi\u200bthere" })).toMatchObject({
      ok: false, message: expect.stringMatching(/^the body contains characters/),
    });
  });

  it("delete_snippet → a proposal with the text and a warning after an agent edit; approve deletes", async () => {
    await call("update_snippet", { snippetId: "sn1", name: "Thanks", type: "text", body: "Thanks!\nSee you soon." });
    const id = await proposeId("delete_snippet", { snippetId: "sn1" });
    expect(row(id).preview).toEqual(expect.arrayContaining([
      { label: "Delete snippet", value: "Thanks (text)" },
      { label: "Body", value: "Thanks!\nSee you soon.", multiline: true },
      { label: "Warning", value: expect.stringContaining("Last edited by API agent abcd1234") },
    ]));
    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read("snippets/sn1")).toBeUndefined();
  });

  it("another sub-account's snippet isn't found", async () => {
    mem.seed("snippets/sn9", { ...SNIPPET, subAccountId: "sa2" });
    expect(await call("update_snippet", { snippetId: "sn9", name: "X", type: "text", body: "Hi" })).toMatchObject({ ok: false, message: "That snippet isn't in this workspace." });
    expect(await call("delete_snippet", { snippetId: "sn9" })).toMatchObject({ ok: false });
  });
});

it("list_whatsapp_templates shows each template's approval per rail and its variables", async () => {
  mem.seed("subAccounts/sa1/whatsappTemplates/t1", {
    name: "install_day", displayName: "Install day", language: "en", status: "approved", contentSid: "HX1", body: "Hi {{1}}",
    variables: [{ position: 1, label: "Name", source: "merge_tag", mergeTag: "contact.firstName" }],
  });
  expect(await call("list_whatsapp_templates", {})).toMatchObject({
    resultText: expect.stringContaining("Install day — id: t1, name: install_day, en, twilio: approved, cloud: none"),
  });
});
