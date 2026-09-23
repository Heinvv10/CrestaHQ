import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The quote PDF (member route and public token route) prints the linked
 * contact's name. A quote naming a contact outside its sub-account (written
 * before the rules checked it) must render as having no contact — never the
 * other tenant's name, email or phone.
 */

const mem = createMemoryFirestore();
const rendered: string[] = [];
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async () => ({ uid: "u1", subAccountId: "sa1", subAccountRole: "admin" }),
}));
vi.mock("@/lib/auth/territory-filter", () => ({ territoryGateForContact: async () => null }));
vi.mock("@/lib/quotes/token", () => ({
  verifyQuoteToken: () => ({ quoteId: "q1" }),
  hashQuoteToken: () => "hash",
}));
vi.mock("@/lib/quotes/pdf-render", () => ({
  pdfFilename: () => "q.pdf",
  renderQuotePdfStream: async (a: { recipientName: string }) => {
    rendered.push(a.recipientName);
    return "pdf";
  },
}));

const member = await import("./route");
const publicRoute = await import("@/app/api/quotes/[token]/pdf/route");

const getMember = () =>
  member.GET(new Request("http://x"), { params: Promise.resolve({ id: "sa1", quoteId: "q1" }) });
const getPublic = () =>
  publicRoute.GET(new Request("http://x"), { params: Promise.resolve({ token: "tok" }) });

beforeEach(() => {
  mem.clear();
  rendered.length = 0;
  mem.seed("subAccounts/sa1", { name: "Biz" });
  mem.seed("contacts/c1", { subAccountId: "sa1", name: "Own Customer" });
  mem.seed("contacts/cB", { subAccountId: "saB", name: "Foreign Customer", email: "f@example.com" });
});

const seedQuote = (contactId: string) =>
  mem.seed("quotes/q1", { subAccountId: "sa1", contactId, publicTokenHash: "hash", quoteNumber: "Q-1" });

it("renders the sub-account's own contact on both routes", async () => {
  seedQuote("c1");
  expect((await getMember()).status).toBe(200);
  expect((await getPublic()).status).toBe(200);
  expect(rendered).toEqual(["Own Customer", "Own Customer"]);
});

it("never renders a contact from another sub-account", async () => {
  seedQuote("cB");
  await getMember();
  await getPublic();
  expect(rendered).toEqual(["(deleted contact)", ""]);
});
