import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /embed/booking/[subAccountId]/[slug] — the iframe target of the
 * booking-embed.js loader. Same published-only gate as /b/[saId]/[slug]:
 * a draft page must 404, not leak into a third-party site's iframe.
 */

const docs = new Map<string, Record<string, unknown>>();
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (p: string) => ({ get: async () => ({ exists: docs.has(p), data: () => docs.get(p) }) }),
  }),
}));
vi.mock("@/components/booking/public-booking-view", () => ({
  PublicBookingView: () => null,
}));

import EmbedBookingPage from "./page";

beforeEach(() => {
  docs.clear();
  docs.set("subAccounts/sa1", { name: "Acme" });
});

describe("the embed booking page", () => {
  it("404s a draft page — the iframe target must not render unpublished content", async () => {
    docs.set("subAccounts/sa1/bookingPages/consult", {
      slug: "consult",
      status: "draft",
      name: "Consult",
      intakeFields: [],
      durationMinutes: 30,
      timezone: "UTC",
      visibleDays: 14,
    });
    await expect(
      EmbedBookingPage({
        params: Promise.resolve({ subAccountId: "sa1", slug: "consult" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("404s a missing page", async () => {
    await expect(
      EmbedBookingPage({
        params: Promise.resolve({ subAccountId: "sa1", slug: "nope" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("404s when the sub-account itself is missing", async () => {
    docs.delete("subAccounts/sa1");
    docs.set("subAccounts/sa1/bookingPages/consult", {
      slug: "consult",
      status: "published",
      name: "Consult",
      intakeFields: [],
      durationMinutes: 30,
      timezone: "UTC",
      visibleDays: 14,
    });
    await expect(
      EmbedBookingPage({
        params: Promise.resolve({ subAccountId: "sa1", slug: "consult" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("renders (doesn't throw) a published page", async () => {
    docs.set("subAccounts/sa1/bookingPages/consult", {
      slug: "consult",
      status: "published",
      name: "Consult",
      intakeFields: [],
      durationMinutes: 30,
      timezone: "UTC",
      visibleDays: 14,
    });
    await expect(
      EmbedBookingPage({
        params: Promise.resolve({ subAccountId: "sa1", slug: "consult" }),
      }),
    ).resolves.toBeTruthy();
  });
});
