import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The public booking page is unauthenticated: the email a visitor types is
 * an unverified claim. On an email match the submitted phone must NOT be
 * written onto the existing contact (it would route that customer's SMS /
 * WhatsApp to whoever booked); it is left as a note for staff instead.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/server/contacts-service", () => ({
  emitContactCreatedById: async () => undefined,
}));

const { reconcileBookingContact } = await import("./contact-reconcile");

const base = { agencyId: "ag1", subAccountId: "sa1", phoneCountry: "ZA" };

beforeEach(() => mem.clear());

it("known email + new phone: existing contact's phone unchanged, a note records the phone", async () => {
  mem.seed("contacts/victim", {
    subAccountId: "sa1", agencyId: "ag1", name: "Naledi",
    email: "naledi@example.com", phone: "",
  });
  const res = await reconcileBookingContact({
    ...base, email: "naledi@example.com", name: "Naledi", phone: "+27821234567",
  });
  expect(res).toEqual({ id: "victim", created: false });
  expect(mem.read("contacts/victim")?.phone).toBe("");
  expect(mem.list("contacts/victim/notes")).toEqual([
    expect.objectContaining({
      content: expect.stringContaining("+27821234567"),
      createdBy: "booking-page",
    }),
  ]);
});

it("still fills a blank name on the matched contact", async () => {
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "", email: "a@b.co", phone: "" });
  await reconcileBookingContact({ ...base, email: "a@b.co", name: "Ann", phone: "" });
  expect(mem.read("contacts/c1")?.name).toBe("Ann");
  expect(mem.list("contacts/c1/notes")).toEqual([]);
});

it("a new visitor becomes a contact with the submitted phone", async () => {
  const res = await reconcileBookingContact({
    ...base, email: "new@example.com", name: "Thandi", phone: "+27829876543",
  });
  expect(res.created).toBe(true);
  expect(mem.read(`contacts/${res.id}`)?.phone).toBe("+27829876543");
});
