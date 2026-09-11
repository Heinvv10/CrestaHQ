import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The hourly quality poll: the pure transition rule, then the sweep for real
 * — real fence, real fake provider, in-memory Firestore that honours `where`.
 * Email and push are the seam's edges and are the only things mocked.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const edges = vi.hoisted(() => ({
  sendEmail: vi.fn(async (_input: Record<string, unknown>) => ({ id: "email_1" })),
  emailIsConfigured: vi.fn(() => true),
  sendPushForEvent: vi.fn(async () => {}),
  pushIsConfigured: vi.fn(() => true),
}));
vi.mock("@/lib/comms/resend", () => ({ sendEmail: edges.sendEmail, emailIsConfigured: edges.emailIsConfigured }));
vi.mock("@/lib/push/send", () => ({ sendPushForEvent: edges.sendPushForEvent }));
vi.mock("@/lib/push/config", () => ({ pushIsConfigured: edges.pushIsConfigured }));

import { mem } from "@/test/gbp-sync-store";
import type { StoredQuality } from "@/types/whatsapp-cloud";
import { whatsappCloudSecretPath } from "@/types/whatsapp-cloud";
import { waFakeScenarioPath, type WaFakeScenario } from "./fake-scenario";
import { alertsCollection } from "./quality-alert";
import { evaluateQualityTransition, runWhatsappQualitySweep } from "./quality-sweep";
import type { WaPhoneStatus, WaQualityRating } from "./types";

const ORIGINAL = { ...process.env };
const AGENCY = "ag_fixture";
const NOW = new Date("2026-09-11T10:15:00Z");
const EARLIER = new Date("2026-09-10T10:15:00Z");

const phone = (qualityRating: WaQualityRating, over: Partial<WaPhoneStatus> = {}): WaPhoneStatus => ({
  displayPhoneNumber: "+27 60 000 0000",
  verifiedName: "E2E Fixture Fibre",
  qualityRating,
  nameStatus: "APPROVED",
  status: "CONNECTED",
  ...over,
});
const stored = (rating: WaQualityRating): StoredQuality => ({
  rating,
  nameStatus: "APPROVED",
  status: "CONNECTED",
  checkedAt: EARLIER,
  changedAt: EARLIER,
});

describe("evaluateQualityTransition", () => {
  it.each([
    ["GREEN", "YELLOW", "drop"],
    ["GREEN", "RED", "drop"],
    ["YELLOW", "GREEN", "recovered"],
    ["RED", "GREEN", "recovered"],
    ["YELLOW", "RED", null],
    ["RED", "YELLOW", null],
    ["GREEN", "GREEN", null],
    ["UNKNOWN", "YELLOW", null],
    ["GREEN", "UNKNOWN", null],
    ["UNKNOWN", "GREEN", null],
  ] as const)("%s → %s = %s", (prev, next, alert) => {
    expect(evaluateQualityTransition(stored(prev), phone(next), NOW).alert).toBe(alert);
  });

  it("never alerts on a first reading, whatever it is", () => {
    for (const r of ["GREEN", "YELLOW", "RED", "UNKNOWN"] as const) {
      expect(evaluateQualityTransition(null, phone(r), NOW)).toEqual({
        reading: { rating: r, nameStatus: "APPROVED", status: "CONNECTED", checkedAt: NOW, changedAt: NOW },
        alert: null,
      });
    }
  });

  it("moves changedAt only when the rating changes", () => {
    expect(evaluateQualityTransition(stored("GREEN"), phone("GREEN", { nameStatus: "PENDING_REVIEW" }), NOW).reading).toMatchObject({
      nameStatus: "PENDING_REVIEW",
      checkedAt: NOW,
      changedAt: EARLIER,
    });
    expect(evaluateQualityTransition(stored("GREEN"), phone("YELLOW"), NOW).reading.changedAt).toBe(NOW);
  });
});

// ── The sweep ────────────────────────────────────────────────────────────
function seedSub(
  id: string,
  over: { agencyId?: string; provider?: string | null; phoneNumberId?: string | null; quality?: StoredQuality | null; email?: Record<string, unknown> } = {},
) {
  mem.seed(`subAccounts/${id}`, {
    agencyId: over.agencyId ?? AGENCY,
    name: `Workspace ${id}`,
    whatsappEnabledByAgency: true,
    whatsappProvider: over.provider === undefined ? "cloud" : over.provider,
    whatsappCloudMeta: {
      phoneNumberId: over.phoneNumberId === undefined ? `pn_${id}` : over.phoneNumberId,
      displayPhoneNumber: `+27 60 000 ${id.slice(-4)}`,
      verifiedName: "E2E Fixture Fibre",
      connectedAt: EARLIER,
      connectedByUid: "uid_admin",
      ...(over.quality !== undefined ? { quality: over.quality } : {}),
    },
    ...(over.email ?? {}),
  });
}
function scenario(id: string, rating: WaQualityRating, extra: Partial<WaFakeScenario> = {}) {
  mem.seed(waFakeScenarioPath(id), {
    phone: phone(rating),
    profile: { about: "", address: "", description: "", email: "", websites: [], vertical: "UNDEFINED", profilePictureUrl: null },
    links: [],
    calls: [],
    ...extra,
  });
}
const quality = (id: string) => (mem.read(`subAccounts/${id}`)?.whatsappCloudMeta as { quality?: StoredQuality }).quality;
const alerts = (id: string) => mem.list(alertsCollection(id));
let warned: string[];

/**
 * Real-Meta mode for the tenants given: each gets its own secret, and a
 * stubbed fetch answers the phone-number node with that tenant's rating.
 */
function graphMode(ratings: Record<string, WaQualityRating>) {
  delete process.env.WHATSAPP_SETTINGS_PROVIDER;
  for (const id of Object.keys(ratings)) {
    mem.seed(whatsappCloudSecretPath(id), { phoneNumberId: `pn_${id}`, wabaId: "w", accessToken: `tok_${id}` });
  }
  const spy = vi.fn(async (url: string, _init?: RequestInit) => {
    const id = Object.keys(ratings).find((k) => url.includes(`/pn_${k}?`));
    const body = { display_phone_number: "+27 60 000 0000", quality_rating: id ? ratings[id] : "GREEN", name_status: "APPROVED", status: "CONNECTED" };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

beforeEach(() => {
  mem.clear();
  edges.sendEmail.mockClear();
  edges.emailIsConfigured.mockReset().mockReturnValue(true);
  edges.sendPushForEvent.mockClear();
  process.env.WHATSAPP_SETTINGS_PROVIDER = "fake";
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
  process.env.WHATSAPP_FAKE_AGENCY_ID = AGENCY;
  delete process.env.WHATSAPP_FAKE_ALLOW_PROD_BUILD;
  (process.env as Record<string, string>).NODE_ENV = "test";
  mem.seed(`agencies/${AGENCY}`, { ownerUid: "uid_owner", supportEmail: "support@fixture.example" });
  mem.seed("users/uid_owner", { email: "owner@fixture.example" });
  warned = [];
  edges.pushIsConfigured.mockReset().mockReturnValue(true);
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warned.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("runWhatsappQualitySweep", () => {
  it("stores a first reading for every cloud sender and alerts nobody", async () => {
    seedSub("sa_a");
    seedSub("sa_b");
    scenario("sa_a", "GREEN");
    scenario("sa_b", "RED");
    const result = await runWhatsappQualitySweep({ now: NOW });
    expect(result).toEqual({ processed: 2, alerted: 0, recovered: 0, failed: 0 });
    expect(quality("sa_a")).toEqual({ rating: "GREEN", nameStatus: "APPROVED", status: "CONNECTED", checkedAt: NOW, changedAt: NOW });
    expect(quality("sa_b")?.rating).toBe("RED");
    expect(alerts("sa_b")).toEqual([]);
    expect(edges.sendEmail).not.toHaveBeenCalled();
    expect(edges.sendPushForEvent).not.toHaveBeenCalled();
    // The rest of the doc survived the merge.
    expect(mem.read("subAccounts/sa_a")).toMatchObject({ whatsappCloudMeta: { phoneNumberId: "pn_sa_a" }, whatsappProvider: "cloud" });
  });

  it("skips sub-accounts not on the cloud rail or without a connected number", async () => {
    seedSub("sa_twilio", { provider: "twilio" });
    seedSub("sa_no_phone", { phoneNumberId: null });
    seedSub("sa_cloud");
    scenario("sa_cloud", "GREEN");
    const result = await runWhatsappQualitySweep({ now: NOW });
    expect(result.processed).toBe(1);
    expect(quality("sa_twilio")).toBeUndefined();
    expect(quality("sa_no_phone")).toBeUndefined();
  });

  it("a drop from GREEN writes a tenant-anchored alert, pushes, and emails the agency owner (real mode)", async () => {
    seedSub("sa_a", { quality: stored("GREEN") });
    graphMode({ sa_a: "YELLOW" });
    const result = await runWhatsappQualitySweep({ now: NOW });
    expect(result).toEqual({ processed: 1, alerted: 1, recovered: 0, failed: 0 });
    expect(quality("sa_a")).toMatchObject({ rating: "YELLOW", checkedAt: NOW, changedAt: NOW });
    expect(alerts("sa_a")).toEqual([
      expect.objectContaining({
        agencyId: AGENCY,
        subAccountId: "sa_a",
        createdByUid: "system",
        from: "GREEN",
        to: "YELLOW",
        phoneNumberId: "pn_sa_a",
        displayPhoneNumber: "+27 60 000 0000",
        createdAt: NOW,
        resolvedAt: null,
      }),
    ]);
    expect(edges.sendPushForEvent).toHaveBeenCalledWith({
      subAccountId: "sa_a",
      agencyId: AGENCY,
      title: "WhatsApp quality dropped to Yellow",
      body: "+27 60 000 0000 — check the WhatsApp settings page",
      url: "/sa/sa_a/dashboard/settings/whatsapp",
      tag: "wa-quality-pn_sa_a",
    });
    expect(edges.sendEmail).toHaveBeenCalledTimes(1);
    const mail = edges.sendEmail.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(mail).toMatchObject({ to: "owner@fixture.example", meter: { subAccountId: "sa_a" }, archive: false });
    expect(String(mail.subject)).toContain("Yellow");
    expect(String(mail.text)).toContain("/sa/sa_a/dashboard/settings/whatsapp");
    expect(warned.filter((w) => w.includes("not configured"))).toEqual([]);
  });

  it("in FAKE mode a drop writes the alert doc but never pushes or emails — and says so", async () => {
    seedSub("sa_a", { quality: stored("GREEN") });
    scenario("sa_a", "YELLOW");
    const result = await runWhatsappQualitySweep({ now: NOW });
    expect(result).toEqual({ processed: 1, alerted: 1, recovered: 0, failed: 0 });
    expect(alerts("sa_a")).toHaveLength(1);
    expect(edges.sendPushForEvent).not.toHaveBeenCalled();
    expect(edges.sendEmail).not.toHaveBeenCalled();
    expect(warned).toContain("[whatsapp-quality] fake mode: push/email suppressed sa=sa_a");
  });

  it("warns when push or email is not configured, so an undelivered alert is visible in the logs", async () => {
    edges.pushIsConfigured.mockReturnValue(false);
    edges.emailIsConfigured.mockReturnValue(false);
    seedSub("sa_a", { quality: stored("GREEN") });
    graphMode({ sa_a: "RED" });
    const result = await runWhatsappQualitySweep({ now: NOW });
    expect(result.alerted).toBe(1);
    expect(alerts("sa_a")).toHaveLength(1); // the alert doc does not depend on either channel
    expect(edges.sendEmail).not.toHaveBeenCalled();
    expect(warned).toContain("[whatsapp-quality] push not configured, alert not delivered sa=sa_a");
    expect(warned).toContain("[whatsapp-quality] email not configured, alert not delivered sa=sa_a");
  });

  it("falls back to the agency's supportEmail when the owner has no email", async () => {
    mem.seed("users/uid_owner", {});
    seedSub("sa_a", { quality: stored("GREEN") });
    graphMode({ sa_a: "RED" });
    await runWhatsappQualitySweep({ now: NOW });
    expect(edges.sendEmail.mock.calls[0][0]).toMatchObject({ to: "support@fixture.example" });
  });

  it("an email failure is logged and does not fail the tenant", async () => {
    edges.sendEmail.mockRejectedValueOnce(new Error("smtp down"));
    seedSub("sa_a", { quality: stored("GREEN") });
    graphMode({ sa_a: "YELLOW" });
    const result = await runWhatsappQualitySweep({ now: NOW });
    expect(result).toEqual({ processed: 1, alerted: 1, recovered: 0, failed: 0 });
    expect(alerts("sa_a")).toHaveLength(1);
    expect(warned.some((w) => w.includes("owner alert failed"))).toBe(true);
  });

  it("YELLOW → RED and YELLOW → YELLOW alert nothing but update the reading", async () => {
    seedSub("sa_a", { quality: stored("YELLOW") });
    scenario("sa_a", "RED");
    const result = await runWhatsappQualitySweep({ now: NOW });
    expect(result).toEqual({ processed: 1, alerted: 0, recovered: 0, failed: 0 });
    expect(quality("sa_a")).toMatchObject({ rating: "RED", changedAt: NOW });
    expect(alerts("sa_a")).toEqual([]);
    expect(edges.sendEmail).not.toHaveBeenCalled();
  });

  it("recovery to GREEN resolves the open alerts and sends nothing", async () => {
    seedSub("sa_a", { quality: stored("YELLOW") });
    mem.seed(`${alertsCollection("sa_a")}/al_open`, { agencyId: AGENCY, subAccountId: "sa_a", from: "GREEN", to: "YELLOW", resolvedAt: null });
    mem.seed(`${alertsCollection("sa_a")}/al_old`, { agencyId: AGENCY, subAccountId: "sa_a", from: "GREEN", to: "RED", resolvedAt: EARLIER });
    scenario("sa_a", "GREEN");
    const result = await runWhatsappQualitySweep({ now: NOW });
    expect(result).toEqual({ processed: 1, alerted: 0, recovered: 1, failed: 0 });
    expect(mem.read(`${alertsCollection("sa_a")}/al_open`)?.resolvedAt).toEqual(NOW);
    expect(mem.read(`${alertsCollection("sa_a")}/al_old`)?.resolvedAt).toEqual(EARLIER);
    expect(edges.sendEmail).not.toHaveBeenCalled();
    expect(edges.sendPushForEvent).not.toHaveBeenCalled();
  });

  it("isolates tenants: one provider failure is counted and the others are still polled", async () => {
    seedSub("sa_a", { quality: stored("GREEN") });
    seedSub("sa_broken", { quality: stored("GREEN") });
    seedSub("sa_c", { quality: stored("GREEN") });
    scenario("sa_a", "GREEN");
    scenario("sa_broken", "YELLOW", { failNext: { op: "getPhoneStatus", status: 500, message: "boom" } });
    scenario("sa_c", "YELLOW");
    const result = await runWhatsappQualitySweep({ now: NOW });
    expect(result).toEqual({ processed: 2, alerted: 1, recovered: 0, failed: 1 });
    expect(quality("sa_broken")).toMatchObject({ rating: "GREEN", checkedAt: EARLIER });
    expect(alerts("sa_broken")).toEqual([]);
    expect(alerts("sa_c")).toHaveLength(1);
  });

  it("in fake mode never reads a sub-account of another agency", async () => {
    seedSub("sa_real", { agencyId: "ag_real_client", quality: stored("GREEN") });
    scenario("sa_real", "RED");
    seedSub("sa_a");
    scenario("sa_a", "GREEN");
    const result = await runWhatsappQualitySweep({ now: NOW });
    expect(result).toEqual({ processed: 1, alerted: 0, recovered: 0, failed: 0 });
    expect(quality("sa_real")).toMatchObject({ rating: "GREEN", checkedAt: EARLIER });
    expect(alerts("sa_real")).toEqual([]);
  });

  it("cannot start on a misconfigured fake (the route answers 500, QStash retries)", async () => {
    delete process.env.WHATSAPP_FAKE_AGENCY_ID;
    seedSub("sa_a");
    await expect(runWhatsappQualitySweep({ now: NOW })).rejects.toThrow(/WHATSAPP_FAKE_AGENCY_ID/);
  });

  it("graph mode: polls every cloud sender with its OWN credentials, whatever agency it is in", async () => {
    delete process.env.WHATSAPP_SETTINGS_PROVIDER;
    seedSub("sa_a", { agencyId: "ag_one", quality: stored("GREEN") });
    seedSub("sa_b", { agencyId: "ag_two" });
    seedSub("sa_unconnected", { agencyId: "ag_two" });
    mem.seed(whatsappCloudSecretPath("sa_a"), { phoneNumberId: "pn_sa_a", wabaId: "w", accessToken: "tok_a" });
    mem.seed(whatsappCloudSecretPath("sa_b"), { phoneNumberId: "pn_sa_b", wabaId: "w", accessToken: "tok_b" });
    const fetchSpy = vi.fn(async (url: string, _init?: RequestInit) => {
      const rating = url.includes("/pn_sa_a?") ? "RED" : "GREEN";
      return new Response(JSON.stringify({ display_phone_number: "+27 1", quality_rating: rating, name_status: "APPROVED", status: "CONNECTED" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const result = await runWhatsappQualitySweep({ now: NOW });
    expect(result).toEqual({ processed: 2, alerted: 1, recovered: 0, failed: 1 });
    expect(quality("sa_a")?.rating).toBe("RED");
    expect(alerts("sa_a")).toHaveLength(1);
    expect(quality("sa_b")?.rating).toBe("GREEN");
    // sa_unconnected has meta but no secret: WabaNotConfiguredError → failed, untouched.
    expect(quality("sa_unconnected")).toBeUndefined();
    const auths = fetchSpy.mock.calls.map(([u, i]) => [String(u).includes("pn_sa_a"), new Headers(i?.headers).get("authorization")]);
    expect(auths).toEqual(expect.arrayContaining([[true, "Bearer tok_a"], [false, "Bearer tok_b"]]));
  });
});
