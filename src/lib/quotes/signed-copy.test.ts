import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryFirestore } from "@/test/memory-firestore";
import { textOf } from "@/test/pdf-text";

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
const rendered = vi.hoisted(() => ({ byDetail: new Map<string, string>(), failNext: false }));
vi.mock("./pdf-render", async (orig) => {
  const real = await orig<typeof import("./pdf-render")>();
  return {
    ...real,
    renderQuotePdfBuffer: async (input: Parameters<typeof real.renderQuotePdfBuffer>[0]) => {
      if (rendered.failNext) throw new Error("render failed");
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
  createdAt: Timestamp.fromDate(new Date("2026-10-18T08:00:00Z")),
  sentAt: Timestamp.fromDate(new Date("2026-10-20T08:00:00Z")),
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
  rendered.failNext = false;
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

  it("passes the right arguments: signer copy filed on the contact, business copy not archived, replies cross over", async () => {
    seed();
    await sendSignedCopies(quote());
    const to = (addr: string) => mail.sendEmail.mock.calls.find((c) => c[0].to === addr)![0];
    expect(to("jane@example.com")).toMatchObject({ contactId: "c1", replyTo: "owner@acme.test" });
    expect(to("jane@example.com").archive).toBeUndefined();
    expect(to("owner@acme.test")).toMatchObject({ archive: false, replyTo: "jane@example.com" });
    expect(to("owner@acme.test").contactId).toBeUndefined();
  });

  it("a contact in another sub-account is no contact: signer copy not filed on it, its name unused", async () => {
    seed();
    mem.seed("contacts/c1", { subAccountId: "sa_other", name: "Mallory", email: "m@evil.test" });
    await sendSignedCopies(quote());
    const signerMail = mail.sendEmail.mock.calls.find((c) => c[0].to === "jane@example.com")![0];
    expect(signerMail.contactId).toBeUndefined();
    expect(String(signerMail.text)).toContain("Hi Jane Doe,");
    expect(String(signerMail.text)).not.toContain("Mallory");
  });

  it("a failing signer send still sends the business copy, keeps the stamp and notes it on the contact", async () => {
    seed();
    mail.sendEmail.mockImplementation(async (a) => {
      if (a.to === "jane@example.com") throw new Error("mailbox full");
      return { id: "m1" };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await sendSignedCopies(quote());
    expect(sentTo().sort()).toEqual(["jane@example.com", "owner@acme.test"]);
    expect(mem.read("quotes/q1")?.signedCopyEmailedAt).toBeInstanceOf(Date);
    const notes = mem.list("contacts/c1/activities").map((d) => String(d.content));
    expect(notes).toEqual([expect.stringContaining("could not be emailed to the signer: mailbox full")]);
    warn.mockRestore();
    mail.sendEmail.mockImplementation(async () => ({ id: "m1" }));
  });

  it("a render failure before any send releases the claim so a retry can send", async () => {
    seed();
    rendered.failNext = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await sendSignedCopies(quote());
    expect(mail.sendEmail).not.toHaveBeenCalled();
    expect(mem.read("quotes/q1")?.signedCopyEmailedAt).toBeUndefined();
    expect(mem.list("contacts/c1/activities").map((d) => String(d.content))).toEqual([
      expect.stringContaining("could not be emailed: render failed"),
    ]);
    rendered.failNext = false;
    await sendSignedCopies(quote());
    expect(mail.sendEmail).toHaveBeenCalledTimes(2);
    warn.mockRestore();
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

  it("defaults to the recipient detail: no email, IP or browser", () => {
    const text = textOf(InvoicePdfDocument({ quote: QUOTE as never, businessName: "Acme Fibre", recipientName: "Jane" }));
    expect(text).toContain("Jane Doe");
    expect(text).not.toMatch(/jane@example\.com|203\.0\.113\.9|Mozilla|IP address|Browser/);
  });

  it("the full certificate adds email, IP and browser", () => {
    const text = certificate("full");
    expect(text).toContain("jane@example.com");
    expect(text).toContain("203.0.113.9");
    expect(text).toContain("Mozilla/5.0 test");
  });

  it("the Issued date is when it was sent, else created, never the render date", () => {
    const issued = (over: Record<string, unknown>) =>
      textOf(InvoicePdfDocument({ quote: { ...QUOTE, ...over } as never, businessName: "Acme", recipientName: "Jane" }));
    expect(issued({})).toContain("Issued 20 Oct 2026");
    expect(issued({ sentAt: null })).toContain("Issued 18 Oct 2026");
    const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    const none = issued({ sentAt: null, createdAt: null });
    expect(none).toContain("Issued —");
    expect(none).not.toContain(today);
  });

  it("renders to a real PDF", async () => {
    const pdf = await renderQuotePdfBuffer({ quote: QUOTE as never, businessName: "Acme <b>&</b>", recipientName: "Jane", certificateDetail: "recipient" });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
