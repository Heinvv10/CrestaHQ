import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/cron/whatsapp-quality — the scheduled poll. The QStash signature
 * is verified for REAL (Upstash's Receiver, with test signing keys), and the
 * signed body is minted exactly the way QStash does (e2e/lib/qstash.ts).
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("@/lib/comms/resend", () => ({ sendEmail: vi.fn(async () => ({ id: "e" })), emailIsConfigured: () => false }));
vi.mock("@/lib/push/send", () => ({ sendPushForEvent: vi.fn(async () => {}) }));

const KEY = "sig_test_current_key_for_wa_cron";
process.env.QSTASH_CURRENT_SIGNING_KEY = KEY;
process.env.QSTASH_NEXT_SIGNING_KEY = "sig_test_next_key_for_wa_cron";

import { signQStashBody } from "../../../../../e2e/lib/qstash";
import { mem } from "@/test/gbp-sync-store";
import { waFakeScenarioPath } from "@/lib/comms/whatsapp/settings/fake-scenario";
import { POST } from "./route";

const ORIGINAL = { ...process.env };
const AGENCY = "ag_fixture";
const URL_ = "http://127.0.0.1:3100/api/cron/whatsapp-quality";

function cron(opts: { signature?: string | null; body?: string } = {}) {
  const body = opts.body ?? "{}";
  const headers: Record<string, string> = {};
  const signature = opts.signature === undefined ? signQStashBody(URL_, body) : opts.signature;
  if (signature !== null) headers["upstash-signature"] = signature;
  return POST(new Request(URL_, { method: "POST", headers, body }));
}

const quality = () => (mem.read("subAccounts/sa_a")?.whatsappCloudMeta as { quality?: unknown })?.quality;

beforeEach(() => {
  mem.clear();
  process.env.QSTASH_CURRENT_SIGNING_KEY = KEY;
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
  process.env.WHATSAPP_SETTINGS_PROVIDER = "fake";
  process.env.WHATSAPP_FAKE_AGENCY_ID = AGENCY;
  (process.env as Record<string, string>).NODE_ENV = "test";
  mem.seed("subAccounts/sa_a", {
    agencyId: AGENCY,
    whatsappProvider: "cloud",
    whatsappCloudMeta: { phoneNumberId: "pn_a", displayPhoneNumber: "+27 60 000 0000", verifiedName: "E2E", connectedAt: null, connectedByUid: null },
  });
  mem.seed(waFakeScenarioPath("sa_a"), {
    phone: { displayPhoneNumber: "+27 60 000 0000", verifiedName: "E2E", qualityRating: "GREEN", nameStatus: "APPROVED", status: "CONNECTED" },
    profile: { about: "", address: "", description: "", email: "", websites: [], vertical: "UNDEFINED", profilePictureUrl: null },
    links: [],
    calls: [],
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("signature", () => {
  it("401s an unsigned call and polls nobody", async () => {
    expect((await cron({ signature: null })).status).toBe(401);
    expect(quality()).toBeUndefined();
  });

  it("401s a forged signature", async () => {
    const [h, p, sig] = signQStashBody(URL_, "{}").split(".");
    const forged = `${h}.${p}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`;
    expect((await cron({ signature: forged })).status).toBe(401);
    expect(quality()).toBeUndefined();
  });

  it("401s a genuine QStash signature minted for ANOTHER cron route (replay)", async () => {
    const other = signQStashBody("http://127.0.0.1:3100/api/cron/gbp-sync", "{}");
    expect((await cron({ signature: other })).status).toBe(401);
    expect(quality()).toBeUndefined();
  });

  it("401s a signature over a different body", async () => {
    expect((await cron({ signature: signQStashBody(URL_, '{"x":1}'), body: "{}" })).status).toBe(401);
  });
});

describe("a signed poll", () => {
  it("runs the sweep and reports the tally", async () => {
    const res = await cron();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ processed: 1, alerted: 0, recovered: 0, failed: 0 });
    expect(quality()).toMatchObject({ rating: "GREEN" });
  });

  it("500s — so QStash retries — when the sweep cannot start", async () => {
    delete process.env.WHATSAPP_FAKE_AGENCY_ID;
    const res = await cron();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "sweep_failed" });
    expect(quality()).toBeUndefined();
  });
});
