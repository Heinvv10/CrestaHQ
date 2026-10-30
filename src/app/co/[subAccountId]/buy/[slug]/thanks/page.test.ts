import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The express buy thanks page through its real loader: it shows an order
 * only to the holder of that order's thanks token, takes paid state from the
 * order doc (never the URL), and shows a download link only once paid.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { default: ThanksPage, metadata } = await import("./page");
const { mintThanksToken } = await import("@/lib/server/product-buy-service");

const SA = "sa1";
const TOKEN = "A".repeat(43);
const DOWNLOAD = "https://files.example.com/guide.pdf";
const ORDER = {
  agencyId: "ag1",
  subAccountId: SA,
  source: "product_link",
  status: "paid",
  currency: "usd",
  totalCents: 49_900,
  lineItems: [{ productId: "p1", name: "Fibre guide", description: "", unitPriceCents: 49_900, quantity: 1, isBump: false }],
  buyerEmail: "buyer@example.com",
  deliveries: [{ productId: "p1", delivery: { type: "download", url: DOWNLOAD, label: "Get the guide" } }],
  thanksTokenHash: createHash("sha256").update(TOKEN).digest("hex"),
};

async function render(search: Record<string, string>, sa = SA): Promise<string> {
  const el = await ThanksPage({
    params: Promise.resolve({ subAccountId: sa, slug: "fibre-guide" }),
    searchParams: Promise.resolve(search),
  });
  return renderToStaticMarkup(el as ReactElement);
}

const LEAKS = ["Fibre guide", "buyer@example.com", DOWNLOAD, "499.00", "Get the guide"];
const expectNothingOfTheOrder = (html: string) => {
  for (const leak of LEAKS) expect(html).not.toContain(leak);
  expect(html).toContain("Thanks for your order");
};

beforeEach(() => {
  mem.clear();
  process.env.RESEND_API_KEY = "re_test";
  process.env.EMAIL_FROM = "shop@example.com";
  mem.seed(`subAccounts/${SA}`, { agencyId: "ag1", name: "Fixture" });
  mem.seed("orders/o1", ORDER);
});

describe("with the order's own token", () => {
  it("paid: item, amount, email and the download link", async () => {
    const html = await render({ order: "o1", t: TOKEN });
    for (const shown of LEAKS) expect(html).toContain(shown);
    expect(html).toContain(`href="${DOWNLOAD}"`);
  });

  it("pending: processing, no download even though the URL is right", async () => {
    mem.seed("orders/o1", { ...ORDER, status: "pending" });
    const html = await render({ order: "o1", t: TOKEN });
    expect(html).toContain("Payment processing");
    expect(html).not.toContain(DOWNLOAD);
  });

  it("refunded: closed, no download", async () => {
    mem.seed("orders/o1", { ...ORDER, status: "refunded" });
    const html = await render({ order: "o1", t: TOKEN });
    expect(html).toContain("no longer active");
    expect(html).not.toContain(DOWNLOAD);
  });

  it("a stored download URL that isn't public https never becomes a link", async () => {
    mem.seed("orders/o1", { ...ORDER, deliveries: [{ productId: "p1", delivery: { type: "download", url: "javascript:alert(1)" } }] });
    const html = await render({ order: "o1", t: TOKEN });
    expect(html).not.toContain("javascript:");
  });

  it("partially refunded: still paid, keeps the download, with a note", async () => {
    mem.seed("orders/o1", { ...ORDER, status: "partially_refunded" });
    const html = await render({ order: "o1", t: TOKEN });
    expect(html).toContain(`href="${DOWNLOAD}"`);
    expect(html).toContain("Part of this payment has been refunded");
  });

  it("paid but flagged (open or resolved) or held: no download", async () => {
    for (const over of [
      { attentionOpen: true, attention: "check it" },
      { attentionOpen: false, attention: "resolved" },
      { status: "partially_refunded", heldAt: new Date() },
    ]) {
      mem.seed("orders/o1", { ...ORDER, ...over });
      const html = await render({ order: "o1", t: TOKEN });
      expect(html).not.toContain(DOWNLOAD);
      expect(html).toContain("quick check");
    }
  });

  it("held (pending, flagged): a quick check, no download", async () => {
    mem.seed("orders/o1", { ...ORDER, status: "pending", attentionOpen: true, attention: "differs" });
    const html = await render({ order: "o1", t: TOKEN });
    expect(html).toContain("quick check");
    expect(html).not.toContain(DOWNLOAD);
  });

  it("expired: says so, nothing charged, no download", async () => {
    mem.seed("orders/o1", { ...ORDER, status: "expired" });
    const html = await render({ order: "o1", t: TOKEN });
    expect(html).toContain("Checkout expired");
    expect(html).toContain("nothing was charged");
    expect(html).not.toContain(DOWNLOAD);
  });

  it("claims a confirmation email only when one can be sent", async () => {
    expect(await render({ order: "o1", t: TOKEN })).toContain("A confirmation is on its way");
    mem.seed("orders/o1", { ...ORDER, confirmationEmail: { state: "failed", error: "x", at: 1 } });
    expect(await render({ order: "o1", t: TOKEN })).not.toContain("on its way");
    mem.seed("orders/o1", ORDER);
    delete process.env.RESEND_API_KEY;
    const html = await render({ order: "o1", t: TOKEN });
    expect(html).not.toContain("on its way");
    expect(html).toContain("Keep this page");
  });

  it("a query param can't claim paid", async () => {
    mem.seed("orders/o1", { ...ORDER, status: "pending" });
    const html = await render({ order: "o1", t: TOKEN, status: "paid", paid: "1" });
    expect(html).not.toContain(DOWNLOAD);
  });
});

describe("leaks nothing", () => {
  it("wrong token", async () => {
    expectNothingOfTheOrder(await render({ order: "o1", t: "B".repeat(43) }));
  });

  it("no token, or a malformed one", async () => {
    expectNothingOfTheOrder(await render({ order: "o1" }));
    expectNothingOfTheOrder(await render({ order: "o1", t: TOKEN.slice(1) }));
  });

  it("another sub-account's order, even with its token", async () => {
    mem.seed("subAccounts/sa2", { agencyId: "ag1", name: "Other" });
    expectNothingOfTheOrder(await render({ order: "o1", t: TOKEN }, "sa2"));
  });

  it("an order from another source, even with a token hash", async () => {
    mem.seed("orders/o1", { ...ORDER, source: "checkout_page" });
    expectNothingOfTheOrder(await render({ order: "o1", t: TOKEN }));
  });

  it("an order with no token hash", async () => {
    mem.seed("orders/o1", Object.fromEntries(Object.entries(ORDER).filter(([k]) => k !== "thanksTokenHash")));
    expectNothingOfTheOrder(await render({ order: "o1", t: TOKEN }));
  });
});

it("mintThanksToken: a fresh 43-char token whose hash the page accepts", async () => {
  const a = mintThanksToken();
  const b = mintThanksToken();
  expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(a.token).not.toBe(b.token);
  mem.seed("orders/o1", { ...ORDER, thanksTokenHash: a.hash });
  expect(await render({ order: "o1", t: a.token })).toContain("Fibre guide");
  expectNothingOfTheOrder(await render({ order: "o1", t: b.token }));
});

it("metadata: never indexed, and the token URL is never sent as a referrer", () => {
  expect(metadata.referrer).toBe("no-referrer");
  expect(metadata.robots).toEqual({ index: false, follow: false });
});
