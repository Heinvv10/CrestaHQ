import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression tests for the capture BACKFILL — the sharpest edge in the
 * pipeline. When a bot matches an existing contact it fills that contact's
 * BLANK fields from what it just heard. Drop the "is it blank?" half of any
 * condition and a hallucinated email silently overwrites a real customer's
 * verified one. Email/phone are never backfilled at all (every caller is
 * public, so the matched identifier is only a claim); each guard has a test
 * here that fails when it is removed. Reconciliation itself is in
 * `capture-reconcile.test.ts`; both share `src/test/capture-harness.ts`.
 */

vi.mock("@/lib/firebase/admin", async () => {
  const h = await import("@/test/capture-harness");
  return { getAdminDb: () => h.getAdminDb() };
});

vi.mock("@/lib/server/contacts-service", async () => {
  const h = await import("@/test/capture-harness");
  return {
    emitContactCreatedById: (...a: unknown[]) =>
      h.emitContactCreated(...(a as [])),
  };
});

import {
  AG,
  SA,
  contacts,
  existing,
  resetHarness,
  setUpdateThrows,
  updates,
} from "@/test/capture-harness";
import { reconcileContactFromCapture } from "./capture";

function reconcile(
  over: Partial<Parameters<typeof reconcileContactFromCapture>[0]> = {}
) {
  return reconcileContactFromCapture({
    agencyId: AG,
    subAccountId: SA,
    existingContactId: null,
    pageUrl: null,
    source: "web-chat",
    matchStrategy: "email-first",
    capture: { name: null, email: null, phone: null },
    ...over,
  });
}

beforeEach(resetHarness);

describe("backfill on an existing contact", () => {
  it("fills a BLANK name from the capture", async () => {
    existing("known", { email: "jane@example.com", name: "" });
    await reconcile({
      capture: { name: "Jane Doe", email: "jane@example.com", phone: null },
    });
    expect(updates[0].patch.name).toBe("Jane Doe");
  });

  it("NEVER overwrites a name already on file", async () => {
    existing("known", { email: "jane@example.com", name: "Jane Q. Doe" });
    await reconcile({
      capture: {
        name: "Bot Heard This",
        email: "jane@example.com",
        phone: null,
      },
    });
    expect(updates.some((u) => "name" in u.patch)).toBe(false);
  });

  it("NEVER overwrites an email already on file", async () => {
    // The scary case: a hallucinated address replacing a verified one.
    existing("known", { phone: "+61412345678", email: "real@customer.com" });
    await reconcile({
      matchStrategy: "phone-first",
      capture: {
        name: null,
        email: "hallucinated@example.com",
        phone: "+61412345678",
      },
    });
    expect(updates.some((u) => "email" in u.patch)).toBe(false);
    expect(contacts[0].data.email).toBe("real@customer.com");
  });

  it("NEVER overwrites a phone already on file", async () => {
    existing("known", { email: "jane@example.com", phone: "+61400000000" });
    await reconcile({
      capture: {
        name: null,
        email: "jane@example.com",
        phone: "+61412345678",
      },
    });
    expect(updates.some((u) => "phone" in u.patch)).toBe(false);
    expect(contacts[0].data.phone).toBe("+61400000000");
  });

  it("treats a whitespace-only stored value as blank and fills it", async () => {
    existing("known", { email: "jane@example.com", name: "   " });
    await reconcile({
      capture: { name: "Jane Doe", email: "jane@example.com", phone: null },
    });
    expect(updates[0].patch.name).toBe("Jane Doe");
  });

  it("writes nothing at all when there is nothing blank to fill", async () => {
    existing("known", {
      email: "jane@example.com",
      name: "Jane",
      phone: "+61400000000",
    });
    await reconcile({
      capture: {
        name: "Jane",
        email: "jane@example.com",
        phone: "+61400000000",
      },
    });
    expect(updates).toHaveLength(0);
  });

  // Every caller is public + unauthenticated: the identifier that matched is
  // only a claim, so the OTHER channel field must never be written onto the
  // existing contact — even when it is blank on file.
  it("NEVER fills a blank phone on a contact matched by email", async () => {
    existing("known", { email: "jane@example.com", phone: "" });
    await reconcile({
      capture: {
        name: null,
        email: "jane@example.com",
        phone: "0412 345 678",
      },
    });
    expect(updates.some((u) => "phone" in u.patch)).toBe(false);
    expect(contacts[0].data.phone).toBe("");
  });

  it("NEVER fills a blank email on a contact matched by phone", async () => {
    existing("known", { phone: "+61412345678", email: "" });
    await reconcile({
      matchStrategy: "phone-first",
      capture: {
        name: null,
        email: "someone@else.test",
        phone: "+61412345678",
      },
    });
    expect(updates.some((u) => "email" in u.patch)).toBe(false);
    expect(contacts[0].data.email).toBe("");
  });

  it("swallows a write error — the capture still resolves the contact", async () => {
    existing("known", { email: "jane@example.com", name: "" });
    setUpdateThrows(true);
    const res = await reconcile({
      capture: { name: "Jane Doe", email: "jane@example.com", phone: null },
    });
    expect(res).toEqual({ contactId: "known", created: false });
  });
});
