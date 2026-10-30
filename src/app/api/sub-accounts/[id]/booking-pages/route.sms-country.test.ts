import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { defaultBookingPageFormData } from "@/lib/booking/defaults";
import { hasExplicitPhoneCountry } from "@/lib/contacts/phone";

/**
 * Turning a page's text reminders on needs the workspace's phone country
 * chosen. Unset reads as US, and texts go only to numbers in the home country,
 * so a workspace elsewhere would switch them on and reach nobody, silently.
 * Through the real create and update routes and the real validator.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: async () => ({ uid: "u1", agencyId: "ag1" }),
  requireSubAccountMember: async () => ({ uid: "u1", agencyId: "ag1" }),
}));

const { POST } = await import("./route");
const { PATCH } = await import("./[slug]/route");

const body = (extra: object) => ({ ...defaultBookingPageFormData("txt", "UTC"), name: "Txt", ...extra });
const req = (method: string, b: unknown) =>
  new Request("http://x/api", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const create = (extra: object) => POST(req("POST", body(extra)), { params: Promise.resolve({ id: "sa1" }) });
const update = (extra: object) => PATCH(req("PATCH", body(extra)), { params: Promise.resolve({ id: "sa1", slug: "txt" }) });
const stored = () => mem.read("subAccounts/sa1/bookingPages/txt") as Record<string, unknown> | undefined;
const error = async (res: Response) => ((await res.json()) as { error?: string }).error ?? "";
const sub = (over: Record<string, unknown> = {}) => mem.seed("subAccounts/sa1", { agencyId: "ag1", ...over });

beforeEach(() => mem.clear());

describe("hasExplicitPhoneCountry", () => {
  it.each(["ZA", "za", " US ", "GB"])("accepts %j", (v) => expect(hasExplicitPhoneCountry(v)).toBe(true));
  it.each([undefined, null, "", "  ", "Z", "ZAF", "1A", "Z-"])("refuses %j", (v) => expect(hasExplicitPhoneCountry(v)).toBe(false));
});

describe("creating a page with texts on", () => {
  it("is refused while the workspace has no phone country, and nothing is stored", async () => {
    sub();
    const res = await create({ smsRemindersEnabled: true });
    expect(res.status).toBe(400);
    expect(await error(res)).toContain("Settings → Phone region");
    expect(stored()).toBeUndefined();
  });

  it.each([[null], [""], ["  "], ["ZAF"]])("is refused for a phone country of %j", async (defaultPhoneCountry) => {
    sub({ defaultPhoneCountry });
    expect((await create({ smsRemindersEnabled: true })).status).toBe(400);
  });

  it("is allowed once the workspace has chosen one", async () => {
    sub({ defaultPhoneCountry: "ZA" });
    expect((await create({ smsRemindersEnabled: true })).status).toBe(200);
    expect(stored()).toMatchObject({ smsRemindersEnabled: true });
  });

  it("a page with texts OFF is not affected, whatever the workspace has", async () => {
    sub();
    expect((await create({ smsRemindersEnabled: false })).status).toBe(200);
    expect(stored()).toMatchObject({ smsRemindersEnabled: false });
  });
});

describe("editing a page", () => {
  it("turning texts on is refused without a phone country, and the stored page stays off", async () => {
    sub();
    expect((await create({})).status).toBe(200);
    const res = await update({ smsRemindersEnabled: true });
    expect(res.status).toBe(400);
    expect(await error(res)).toContain("Phone region");
    expect(stored()).toMatchObject({ smsRemindersEnabled: false });
  });

  it("turning texts on is allowed with one", async () => {
    sub({ defaultPhoneCountry: "ZA" });
    await create({});
    expect((await update({ smsRemindersEnabled: true })).status).toBe(200);
    expect(stored()).toMatchObject({ smsRemindersEnabled: true });
  });

  it("an unrelated edit of a page that is already on is not blocked", async () => {
    sub({ defaultPhoneCountry: "ZA" });
    await create({ smsRemindersEnabled: true });
    sub();
    expect((await update({ smsRemindersEnabled: true, description: "New words" })).status).toBe(200);
    expect(stored()).toMatchObject({ description: "New words", smsRemindersEnabled: true });
  });

  it("turning texts off is never blocked", async () => {
    sub({ defaultPhoneCountry: "ZA" });
    await create({ smsRemindersEnabled: true });
    sub();
    expect((await update({ smsRemindersEnabled: false })).status).toBe(200);
  });
});
