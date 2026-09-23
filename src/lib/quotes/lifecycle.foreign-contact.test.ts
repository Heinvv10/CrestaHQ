import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * recordQuoteActivity writes onto the quote's contact timeline by id. A quote
 * written before the rules checked `contactId` may name another tenant's
 * contact: that write must be skipped, the own-contact write kept.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { recordQuoteActivity } = await import("./lifecycle");

const quote = (contactId: string) => ({
  id: "q1", subAccountId: "sa1", contactId, quoteNumber: "Q-1", currency: "USD",
  lineItems: [], globalDiscount: null, globalTaxPercent: 0, kind: "quote" as const,
});

beforeEach(() => {
  mem.clear();
  mem.seed("contacts/c1", { subAccountId: "sa1" });
  mem.seed("contacts/cB", { subAccountId: "saB" });
});

it("writes the activity on the sub-account's own contact", async () => {
  await recordQuoteActivity(quote("c1") as never, "quote_sent");
  expect(mem.list("contacts/c1/activities")).toHaveLength(1);
});

it("skips a contact from another sub-account", async () => {
  await recordQuoteActivity(quote("cB") as never, "quote_sent");
  expect(mem.list("contacts/cB/activities")).toEqual([]);
});
