import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

/**
 * Regression tests for `reconcileContactFromCapture` — the boundary where LLM
 * output becomes CRM data. It must never mint an orphan contact from a name
 * alone, must prefer the channel's stated match identifier, must stay inside
 * the sub-account, and must still match legacy contacts whose phone was stored
 * as-typed rather than E.164. The backfill guards are in
 * `capture-backfill.test.ts`; both share `src/test/capture-harness.ts`.
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
  adds,
  contacts,
  emitContactCreated,
  existing,
  getAdminDb,
  resetHarness,
  setSubAccountDoc,
} from "@/test/capture-harness";
import { reconcileContactFromCapture } from "./capture";
import { GLOBAL_TERRITORY_ID } from "@/types";

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

// ---- short-circuit + orphan guard ----

describe("reconcileContactFromCapture — early exits", () => {
  it("short-circuits on an already-bound contact without touching Firestore", async () => {
    const res = await reconcile({
      existingContactId: "bound1",
      capture: { name: "Jane", email: "jane@example.com", phone: null },
    });
    expect(res).toEqual({ contactId: "bound1", created: false });
    expect(getAdminDb).not.toHaveBeenCalled();
    expect(adds).toHaveLength(0);
  });

  it("returns null when only a name was captured — no orphan contact", async () => {
    const res = await reconcile({
      capture: { name: "Definitely A Person", email: null, phone: null },
    });
    expect(res).toBeNull();
    expect(adds).toHaveLength(0);
    expect(emitContactCreated).not.toHaveBeenCalled();
  });

  it("returns null when nothing at all was captured", async () => {
    expect(await reconcile()).toBeNull();
    expect(adds).toHaveLength(0);
  });
});

// ---- match order ----

describe("reconcileContactFromCapture — match order", () => {
  it("email-first prefers the email match over the phone match", async () => {
    existing("byEmail", { email: "jane@example.com" });
    existing("byPhone", { phone: "+61412345678" });
    const res = await reconcile({
      matchStrategy: "email-first",
      capture: {
        name: null,
        email: "jane@example.com",
        phone: "+61412345678",
      },
    });
    expect(res).toEqual({ contactId: "byEmail", created: false });
  });

  it("phone-first prefers the phone match over the email match", async () => {
    existing("byEmail", { email: "jane@example.com" });
    existing("byPhone", { phone: "+61412345678" });
    const res = await reconcile({
      matchStrategy: "phone-first",
      capture: {
        name: null,
        email: "jane@example.com",
        phone: "+61412345678",
      },
    });
    expect(res).toEqual({ contactId: "byPhone", created: false });
  });

  it("falls back to the other identifier when the preferred one misses", async () => {
    existing("byPhone", { phone: "+61412345678" });
    const res = await reconcile({
      matchStrategy: "email-first",
      capture: {
        name: null,
        email: "nobody@example.com",
        phone: "+61412345678",
      },
    });
    expect(res).toEqual({ contactId: "byPhone", created: false });
  });

  it("matches only within the sub-account — another tenant's contact is invisible", async () => {
    contacts.push({
      id: "otherTenant",
      data: { subAccountId: "sa_other", email: "jane@example.com" },
    });
    const res = await reconcile({
      capture: { name: null, email: "jane@example.com", phone: null },
    });
    expect(res?.created).toBe(true);
    expect(res?.contactId).not.toBe("otherTenant");
  });
});

// ---- phone normalization ----

describe("reconcileContactFromCapture — phone normalization", () => {
  it("matches a contact stored in E.164 from a nationally-typed capture", async () => {
    existing("e164", { phone: "+61412345678" });
    const res = await reconcile({
      matchStrategy: "phone-first",
      capture: { name: null, email: null, phone: "0412 345 678" },
    });
    expect(res).toEqual({ contactId: "e164", created: false });
  });

  it("still matches a LEGACY contact whose phone was stored as-typed", async () => {
    // The normalized candidate misses; the as-typed candidate is the fallback.
    existing("legacy", { phone: "0412 345 678" });
    const res = await reconcile({
      matchStrategy: "phone-first",
      capture: { name: null, email: null, phone: "0412 345 678" },
    });
    expect(res).toEqual({ contactId: "legacy", created: false });
  });

  it("stores the normalized E.164 on a newly created contact", async () => {
    await reconcile({
      capture: { name: null, email: null, phone: "0412 345 678" },
    });
    expect(adds[0].phone).toBe("+61412345678");
  });

  it("keeps an unparseable number as-typed rather than dropping it", async () => {
    await reconcile({
      capture: { name: null, email: null, phone: "12345" },
    });
    expect(adds[0].phone).toBe("12345");
  });

  it("uses the workspace's default phone country for bare national numbers", async () => {
    setSubAccountDoc({ defaultPhoneCountry: "US" });
    await reconcile({
      capture: { name: null, email: null, phone: "(415) 555-2671" },
    });
    expect(adds[0].phone).toBe("+14155552671");
  });
});

// ---- creation ----

describe("reconcileContactFromCapture — creating a contact", () => {
  it("stamps tenancy, source and territory, and reports created:true", async () => {
    const res = await reconcile({
      source: "voice",
      pageUrl: null,
      capture: { name: "Jane", email: "jane@example.com", phone: null },
    });
    expect(res?.created).toBe(true);
    expect(adds[0]).toMatchObject({
      agencyId: AG,
      subAccountId: SA,
      source: "voice",
      createdByUid: "voice-bot",
      name: "Jane",
      email: "jane@example.com",
      territoryId: GLOBAL_TERRITORY_ID,
      emailOptedOut: false,
      smsOptedOut: false,
    });
  });

  it("fires contact.created for the new contact", async () => {
    const res = await reconcile({
      capture: { name: null, email: "jane@example.com", phone: null },
    });
    await flushAfterResponse();
    expect(emitContactCreated).toHaveBeenCalledWith({
      subAccountId: SA,
      agencyId: AG,
      contactId: res!.contactId,
    });
  });

  it("does NOT fire contact.created when an existing contact was matched", async () => {
    existing("known", { email: "jane@example.com" });
    await reconcile({
      capture: { name: null, email: "jane@example.com", phone: null },
    });
    expect(emitContactCreated).not.toHaveBeenCalled();
  });

  it("records the landing page as attribution when the channel supplies one", async () => {
    await reconcile({
      pageUrl: "https://acme.test/pricing",
      capture: { name: null, email: "jane@example.com", phone: null },
    });
    expect(adds[0].attribution).toEqual({
      landingPage: "https://acme.test/pricing",
    });
  });
});

// ---- email case ----

describe("reconcileContactFromCapture — email case", () => {
  it("matches an existing lower-case email when the visitor typed mixed case", async () => {
    existing("jane", { email: "jane@example.com" });
    const res = await reconcile({
      capture: { name: null, email: "Jane@Example.COM", phone: null },
    });
    expect(res).toEqual({ contactId: "jane", created: false });
    expect(adds).toHaveLength(0);
  });

  it("stores a new contact's email lower-cased", async () => {
    await reconcile({ capture: { name: null, email: "New@Example.com", phone: null } });
    expect(adds[0].email).toBe("new@example.com");
  });

  it("still matches a legacy contact stored with the as-typed case", async () => {
    existing("legacy", { email: "Old@Example.com" });
    const res = await reconcile({
      capture: { name: null, email: "Old@Example.com", phone: null },
    });
    expect(res).toEqual({ contactId: "legacy", created: false });
  });
});
