import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Duplicating a page copies its availability rules — page and per-host
 * date-specific hours, before-buffer and slot interval — through the real
 * route, validator and host resolution.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
const auth = vi.hoisted(() => ({ admin: vi.fn(async () => ({ uid: "u1", agencyId: "ag1" })) }));
vi.mock("@/lib/auth/require-tenancy", () => ({ requireSubAccountAdmin: auth.admin }));

const { POST } = await import("./route");

const closed = [{ date: "2026-12-25", ranges: [] }];
const short = [{ date: "2026-12-24", ranges: [{ startMinute: 540, endMinute: 600 }] }];

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  mem.seed("subAccounts/sa1/subAccountMembers/a", { uid: "a", status: "active", displayName: "Ann" });
  mem.seed("subAccounts/sa1/bookingPages/src", {
    id: "src",
    slug: "src",
    name: "Source",
    description: "",
    status: "published",
    durationMinutes: 30,
    bufferMinutes: 10,
    bufferBeforeMinutes: 15,
    slotIntervalMinutes: 20,
    workingHours: [{ dayOfWeek: 1, startMinute: 540, endMinute: 1020 }],
    dateOverrides: closed,
    timezone: "UTC",
    visibleDays: 14,
    minNoticeHours: 2,
    maxPerDay: null,
    intakeFields: [],
    hosts: [{ uid: "a", name: "Ann", dateOverrides: short }],
    logoUrl: null,
    accentColor: null,
    confirmationMessage: "",
    remindersEnabled: true,
    reminderOffsetsMinutes: [1440, 60],
    payment: null,
    territoryId: "global",
    defaultTerritoryId: null,
    agencyId: "ag1",
    subAccountId: "sa1",
    createdByUid: "u1",
  });
});

describe("duplicate", () => {
  it.each([
    ["a slug that is a path", "sa1", "src/../src"],
    ["a slug of ..", "sa1", ".."],
    ["a sub-account id that is a path", "sa1/bookingPages/src", "src"],
    ["a reserved id", "__sa__", "src"],
  ])("404s %s before any read or auth", async (_label, id, slug) => {
    auth.admin.mockClear();
    const before = mem.list("subAccounts/sa1/bookingPages").length;
    const res = await POST(new Request("http://x/api", { method: "POST" }), {
      params: Promise.resolve({ id, slug }),
    });
    expect(res.status).toBe(404);
    expect(auth.admin).not.toHaveBeenCalled();
    expect(mem.list("subAccounts/sa1/bookingPages")).toHaveLength(before);
  });

  it("copies date-specific hours (page and host), before-buffer and slot interval", async () => {
    const res = await POST(new Request("http://x/api", { method: "POST" }), {
      params: Promise.resolve({ id: "sa1", slug: "src" }),
    });
    expect(res.status).toBe(200);
    const { slug } = (await res.json()) as { slug: string };
    expect(slug).toBe("src-copy");
    expect(mem.read(`subAccounts/sa1/bookingPages/${slug}`)).toMatchObject({
      status: "draft",
      bufferMinutes: 10,
      bufferBeforeMinutes: 15,
      slotIntervalMinutes: 20,
      dateOverrides: closed,
      hosts: [{ uid: "a", name: "Ann", dateOverrides: short }],
    });
  });

  it.each([
    ["the text-reminders toggle when on", true, true],
    ["the text-reminders toggle as off when the page predates it", undefined, false],
  ])("copies %s", async (_label, stored, copied) => {
    const path = "subAccounts/sa1/bookingPages/src";
    mem.seed(path, { ...mem.read(path)!, ...(stored === undefined ? {} : { smsRemindersEnabled: stored }) });
    const res = await POST(new Request("http://x/api", { method: "POST" }), {
      params: Promise.resolve({ id: "sa1", slug: "src" }),
    });
    expect(res.status).toBe(200);
    const { slug } = (await res.json()) as { slug: string };
    expect(mem.read(`subAccounts/sa1/bookingPages/${slug}`)!.smsRemindersEnabled).toBe(copied);
  });

  it.each([
    ["a style preset", "ocean", "ocean"],
    ["no preset on a page stored before presets", undefined, null],
    ["no preset when the stored one is unrecognised, instead of failing", "bogus", null],
  ])("copies %s", async (_label, stored, copied) => {
    const path = "subAccounts/sa1/bookingPages/src";
    mem.seed(path, { ...mem.read(path)!, ...(stored === undefined ? {} : { themePreset: stored }) });
    const res = await POST(new Request("http://x/api", { method: "POST" }), {
      params: Promise.resolve({ id: "sa1", slug: "src" }),
    });
    expect(res.status).toBe(200);
    const { slug } = (await res.json()) as { slug: string };
    expect(mem.read(`subAccounts/sa1/bookingPages/${slug}`)!.themePreset).toBe(copied);
  });
});
