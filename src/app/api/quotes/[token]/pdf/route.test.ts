import { Timestamp } from "firebase-admin/firestore";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { createMemoryFirestore } from "@/test/memory-firestore";
import { textOf } from "@/test/pdf-text";

/**
 * The public, link-gated quote PDF of a SIGNED quote: through the real route
 * and token check, with the real InvoicePdfDocument. Anyone holding the link
 * can download it, so its certificate must not carry the signer's email, IP or
 * browser. Only the PDF stream is stubbed: it returns the document's text.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/quotes/pdf-render", async () => {
  const { InvoicePdfDocument } = await import("@/lib/quotes/pdf-document");
  return {
    pdfFilename: () => "Q.pdf",
    renderQuotePdfStream: async (input: Parameters<typeof InvoicePdfDocument>[0]) =>
      new Response(textOf(InvoicePdfDocument(input))).body,
  };
});

process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-public-pdf-fixture";
const { GET } = await import("./route");
const { issueQuoteToken } = await import("@/lib/quotes/token");

let token = "";
beforeAll(() => {
  const issued = issueQuoteToken("q1");
  token = issued.token;
  mem.seed("quotes/q1", {
    agencyId: "ag1",
    subAccountId: "sa1",
    createdByUid: "u1",
    contactId: "c1",
    kind: "quote",
    status: "accepted",
    quoteNumber: "Q-1",
    currency: "ZAR",
    lineItems: [{ id: "l1", description: "Install", quantity: 1, unitPrice: 100 }],
    publicTokenHash: issued.hash,
    signature: {
      signerName: "Jane Doe",
      signedAsNumber: "Q-1",
      signerEmail: "jane@example.com",
      signedAt: Timestamp.fromDate(new Date("2026-10-29T10:00:00Z")),
      ipAddress: "203.0.113.9",
      userAgent: "Mozilla/5.0 test",
      documentHash: "ab".repeat(32),
      hashVersion: 1,
    },
  });
  mem.seed("subAccounts/sa1", { name: "Acme" });
  mem.seed("contacts/c1", { subAccountId: "sa1", name: "Jane" });
});

describe("GET /api/quotes/[token]/pdf on a signed quote", () => {
  it("shows who and when and the fingerprint, but no email, IP or browser rows", async () => {
    const res = await GET(new Request("http://localhost/x"), { params: Promise.resolve({ token }) });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Jane Doe");
    expect(text).toContain("ab".repeat(32));
    expect(text).not.toMatch(/jane@example\.com|203\.0\.113\.9|Mozilla|IP address|Browser/);
  });
});
