import { beforeEach, describe, expect, it, vi } from "vitest";
import { mem } from "@/test/agent-proposals-harness";

/** POST /quotes, now a thin caller of lib/server/quote-write.ts: it still
 *  writes the draft, and still refuses as before. */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());

const { POST } = await import("./route");
const post = (body: Record<string, unknown>) =>
  POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "sa1" }) });
const LINE = { description: "Install", quantity: 1, unitPrice: 500 };

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Ann", territoryId: "global" });
});

describe("POST /quotes", () => {
  it("writes the draft with its number, lines and the member as creator, unstamped", async () => {
    const res = await post({ contactId: "c1", kind: "invoice", lineItems: [LINE], currency: "zar" });
    expect(res.status).toBe(201);
    const { id, quoteNumber } = (await res.json()) as { id: string; quoteNumber: string };
    expect(mem.read(`quotes/${id}`)).toMatchObject({ subAccountId: "sa1", kind: "invoice", status: "draft", contactId: "c1", currency: "ZAR", quoteNumber, createdByUid: "u_admin" });
    expect(mem.read(`quotes/${id}`)).not.toHaveProperty("lastAgentEditKey");
  });

  it.each([
    ["a quote by default (opt-in)", { kind: "quote" }, false],
    ["a quote with the toggle on", { kind: "quote", requireSignature: true }, true],
    ["a quote with a truthy non-boolean toggle", { kind: "quote", requireSignature: "yes" }, false],
    ["an invoice, even asked to", { kind: "invoice", requireSignature: true }, false],
  ])("requireSignature: %s -> %s, and never a signature", async (_label, over, expected) => {
    const res = await post({ contactId: "c1", lineItems: [LINE], ...over });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(mem.read(`quotes/${id}`)).toMatchObject({ requireSignature: expected, signature: null });
  });

  it("a signature in the body is not written", async () => {
    const res = await post({ contactId: "c1", lineItems: [LINE], signature: { signerName: "Forged", documentHash: "x" } });
    const { id } = (await res.json()) as { id: string };
    expect(mem.read(`quotes/${id}`)!.signature).toBeNull();
  });

  it.each([
    ["no lines", { contactId: "c1", lineItems: [] }, 400],
    ["another contact's deal", { contactId: "c1", lineItems: [LINE], dealId: "d_ben" }, 400],
    ["an unknown contact", { contactId: "c_gone", lineItems: [LINE] }, 404],
  ])("%s -> %s, nothing written", async (_label, body, status) => {
    mem.seed("deals/d_ben", { subAccountId: "sa1", contactId: "c2" });
    expect((await post(body)).status).toBe(status);
    expect(mem.list("quotes")).toEqual([]);
  });
});
