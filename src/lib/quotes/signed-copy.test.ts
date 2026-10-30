import { Timestamp } from "firebase-admin/firestore";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The signed copy emails, through the real sendSignedCopies, the real claim
 * transaction (in-memory Firestore) and the real PDF renderer. Only the mail
 * provider is stubbed. Covers:
 *   - one send per signature, however often it is triggered or how concurrently;
 *   - the signer's copy omits IP and browser, the business copy carries them;
 *   - the certificate page carries the fingerprint and hash version;
 *   - email not configured: nothing sent, nothing claimed, the signature intact.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
const mail = vi.hoisted(() => ({
  configured: true,
  sendEmail: vi.fn(async (_a: Record<string, unknown>) => ({ id: "m1" })),
}));
vi.mock("@/lib/comms/resend", () => ({
  emailIsConfigured: () => mail.configured,
  sendEmail: (a: Record<string, unknown>) => mail.sendEmail(a),
  tenantFrom: () => undefined,
}));

// The real renderer, recording which certificate detail produced which bytes.
const rendered = vi.hoisted(() => ({ byDetail: new Map<string, string>() }));
vi.mock("./pdf-render", async (orig) => {
  const real = await orig<typeof import("./pdf-render")>();
  return {
    ...real,
    renderQuotePdfBuffer: async (input: Parameters<typeof real.renderQuotePdfBuffer>[0]) => {
      const pdf = await real.renderQuotePdfBuffer(input);
      rendered.byDetail.set(String(input.certificateDetail), pdf.toString("base64"));
      return pdf;
    },
  };
});

const { sendSignedCopies, signedCopyExpected } = await import("./signed-copy");
const { InvoicePdfDocument } = await import("./pdf-document");
const { renderQuotePdfBuffer } = await import("./pdf-render");

const HASH = "ab".repeat(32);
const QUOTE = {
  id: "q1",
  agencyId: "ag1",
  subAccountId: "sa1",
  createdByUid: "u1",
  contactId: "c1",
  kind: "quote",
  status: "accepted",
  quoteNumber: "Q-2026-0007",
  currency: "ZAR",
  lineItems: [{ id: "li1", description: "Fibre install", quantity: 1, unitPrice: 1500 }],
  globalDiscount: null,
  globalTaxPercent: 15,
  termsAndNotes: null,
  billedToOrganization: null,
  billingAddress: null,
  validUntil: null,
  signature: {
    signerName: "Jane Doe",
    signedAsNumber: "Q-2026-0007",
    signerEmail: "jane@example.com",
    signedAt: Timestamp.fromDate(new Date("2026-10-29T10:00:00Z")),
    ipAddress: "203.0.113.9",
    userAgent: "Mozilla/5.0 test",
    documentHash: HASH,
    hashVersion: 1,
  },
};

function seed(over: Record<string, unknown> = {}) {
  mem.seed("quotes/q1", { ...QUOTE, ...over });
  mem.seed("subAccounts/sa1", { name: "Acme Fibre", accountContact: { email: "fallback@acme.test" } });
  mem.seed("contacts/c1", { subAccountId: "sa1", name: "Jane", email: "jane@example.com" });
  mem.seed("users/u1", { email: "owner@acme.test" });
}
const quote = () => ({ ...(mem.read("quotes/q1") as object), id: "q1" }) as never;
const sentTo = () => mail.sendEmail.mock.calls.map((c) => c[0].to);

/** Every string in a React element tree: what the PDF would print. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf((node as ReactElement<{ children?: ReactNode }>).props?.children);
}
const certificate = (detail: "full" | "recipient") =>
  textOf(
    InvoicePdfDocument({
      quote: QUOTE as never,
      businessName: "Acme Fibre",
      recipientName: "Jane",
      certificateDetail: detail,
    }),
  );

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  mail.configured = true;
});

describe("sendSignedCopies", () => {
  it("emails the signer and the business, each with a PDF", async () => {
    seed();
    await sendSignedCopies(quote());
    expect(sentTo().sort()).toEqual(["jane@example.com", "owner@acme.test"]);
    for (const [args] of mail.sendEmail.mock.calls) {
      const att = (args.attachments as { filename: string; content: string }[])[0];
      expect(att.filename).toBe("Q-2026-0007-signed.pdf");
      expect(Buffer.from(att.content, "base64").subarray(0, 5).toString()).toBe("%PDF-");
      expect(args.meter).toEqual({ subAccountId: "sa1" });
    }
    expect(mem.read("quotes/q1")?.signedCopyEmailedAt).toBeInstanceOf(Date);
  });

  it("the signer gets the recipient certificate, the business the full one", async () => {
    seed();
    await sendSignedCopies(quote());
    const attachmentTo = (to: string) =>
      (mail.sendEmail.mock.calls.find((c) => c[0].to === to)![0].attachments as { content: string }[])[0].content;
    expect(attachmentTo("jane@example.com")).toBe(rendered.byDetail.get("recipient"));
    expect(attachmentTo("owner@acme.test")).toBe(rendered.byDetail.get("full"));
    expect(rendered.byDetail.get("recipient")).not.toBe(rendered.byDetail.get("full"));
  });

  it("falls back to the sub-account contact when the creator has no email", async () => {
    seed();
    mem.seed("users/u1", {});
    await sendSignedCopies(quote());
    expect(sentTo().sort()).toEqual(["fallback@acme.test", "jane@example.com"]);
  });

  it("a replay sends nothing more", async () => {
    seed();
    await sendSignedCopies(quote());
    await sendSignedCopies(quote());
    expect(mail.sendEmail).toHaveBeenCalledTimes(2);
  });

  it("concurrent triggers send once", async () => {
    seed();
    await Promise.all([sendSignedCopies(quote()), sendSignedCopies(quote()), sendSignedCopies(quote())]);
    expect(mail.sendEmail).toHaveBeenCalledTimes(2);
  });

  it("email not configured: nothing sent, nothing claimed, the signature is untouched", async () => {
    seed();
    mail.configured = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await sendSignedCopies(quote());
    expect(mail.sendEmail).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("email not configured"));
    expect(mem.read("quotes/q1")?.signedCopyEmailedAt).toBeUndefined();
    expect(mem.read("quotes/q1")?.signature).toEqual(QUOTE.signature);
    warn.mockRestore();
  });

  it("an unsigned quote sends nothing", async () => {
    seed({ signature: null });
    await sendSignedCopies({ ...(quote() as object), signature: null } as never);
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it("a failing send does not throw", async () => {
    seed();
    mail.sendEmail.mockRejectedValueOnce(new Error("smtp down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(sendSignedCopies(quote())).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it("a signature with no signer email still notifies the business only", async () => {
    seed({ signature: { ...QUOTE.signature, signerEmail: null } });
    await sendSignedCopies({ ...(quote() as object) } as never);
    expect(sentTo()).toEqual(["owner@acme.test"]);
  });
});

describe("signedCopyExpected", () => {
  it("is true only with an address and email configured", async () => {
    seed();
    expect(await signedCopyExpected(quote())).toBe(true);
    mail.configured = false;
    expect(await signedCopyExpected(quote())).toBe(false);
    mail.configured = true;
    expect(await signedCopyExpected({ ...(quote() as object), signature: { ...QUOTE.signature, signerEmail: null } } as never)).toBe(false);
  });
});

describe("the certificate page", () => {
  it("carries the signer, time, fingerprint and hash version", () => {
    const text = certificate("recipient");
    expect(text).toContain("Signature certificate");
    expect(text).toContain("Jane Doe");
    expect(text).toContain("Thu, 29 Oct 2026 10:00:00 GMT (UTC)");
    expect(text).toContain(`SHA-256 ${HASH}`);
    expect(text).toContain("Record version 1");
  });

  it("the signer's copy omits IP and browser; the full one has them", () => {
    expect(certificate("recipient")).not.toMatch(/203\.0\.113\.9|Mozilla|IP address/);
    expect(certificate("full")).toMatch(/203\.0\.113\.9/);
    expect(certificate("full")).toMatch(/Mozilla\/5\.0 test/);
  });

  it("renders to a real PDF", async () => {
    const pdf = await renderQuotePdfBuffer({ quote: QUOTE as never, businessName: "Acme <b>&</b>", recipientName: "Jane", certificateDetail: "recipient" });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
