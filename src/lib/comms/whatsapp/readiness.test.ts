import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SubAccountDoc } from "@/types";

const whatsappCloudIsConfigured = vi.fn();
const subAccountWhatsappIsConfigured = vi.fn();
const getBridgeCreds = vi.fn();
const bridgeHealth = vi.fn();

vi.mock("./cloud-credentials", () => ({
  whatsappCloudIsConfigured: (...a: unknown[]) => whatsappCloudIsConfigured(...a),
}));
vi.mock("./bridge-credentials", () => ({
  getBridgeCreds: (...a: unknown[]) => getBridgeCreds(...a),
}));
vi.mock("./bridge-client", () => ({
  bridgeHealth: (...a: unknown[]) => bridgeHealth(...a),
}));
vi.mock("@/lib/comms/twilio", () => ({
  subAccountWhatsappIsConfigured: (...a: unknown[]) =>
    subAccountWhatsappIsConfigured(...a),
}));

import { checkWhatsappReadiness } from "./readiness";

const sub = (provider?: string, twilioConfig: unknown = null) =>
  ({ whatsappProvider: provider, twilioConfig }) as unknown as SubAccountDoc;

describe("checkWhatsappReadiness", () => {
  beforeEach(() => {
    whatsappCloudIsConfigured.mockReset();
    subAccountWhatsappIsConfigured.mockReset();
    getBridgeCreds.mockReset();
    bridgeHealth.mockReset();
  });

  it("checks Twilio credentials for a legacy workspace", async () => {
    subAccountWhatsappIsConfigured.mockReturnValue(true);
    await expect(
      checkWhatsappReadiness({ subAccountId: "sa_1", subAccount: sub() }),
    ).resolves.toEqual({
      ready: true,
      provider: "twilio",
      sender: expect.objectContaining({ provider: "twilio" }),
    });
  });

  it("does NOT require Twilio credentials on the cloud rail", async () => {
    // The bug this guards: a workspace fully cut over to Cloud has no reason
    // to keep Twilio configured, and demanding it refuses a correctly
    // configured workspace — defeating the entire point of the seam.
    whatsappCloudIsConfigured.mockResolvedValue(true);
    const r = await checkWhatsappReadiness({
      subAccountId: "sa_1",
      subAccount: sub("cloud", null),
    });
    expect(r).toEqual({
      ready: true,
      provider: "cloud",
      sender: expect.objectContaining({ provider: "cloud" }),
    });
    expect(subAccountWhatsappIsConfigured).not.toHaveBeenCalled();
  });

  it("does NOT accept Twilio credentials as readiness for the cloud rail", async () => {
    // The mirror of the bug. A workspace switched to Cloud but never
    // connected would otherwise pass on its leftover Twilio config and then
    // fail deep inside a Graph call.
    subAccountWhatsappIsConfigured.mockReturnValue(true);
    whatsappCloudIsConfigured.mockResolvedValue(false);
    const r = await checkWhatsappReadiness({
      subAccountId: "sa_1",
      subAccount: sub("cloud", { enabled: true }),
    });
    expect(r.ready).toBe(false);
  });

  it("reports the cloud rail in its error, not Twilio's settings page", async () => {
    whatsappCloudIsConfigured.mockResolvedValue(false);
    const r = await checkWhatsappReadiness({
      subAccountId: "sa_1",
      subAccount: sub("cloud"),
    });
    expect(r.ready).toBe(false);
    if (!r.ready) expect(r.error).toContain("Settings → WhatsApp");
  });

  it("is ready on the bridge rail when the bridge is configured and connected", async () => {
    getBridgeCreds.mockResolvedValue({
      baseUrl: "http://b:1",
      token: "t",
      webhookSecret: "w",
    });
    bridgeHealth.mockResolvedValue({
      reachable: true,
      connected: true,
      killed: false,
      number: "+2782",
    });
    const r = await checkWhatsappReadiness({
      subAccountId: "sa_1",
      subAccount: sub("bridge"),
    });
    expect(r).toEqual({
      ready: true,
      provider: "bridge",
      sender: expect.objectContaining({ provider: "bridge" }),
    });
    expect(subAccountWhatsappIsConfigured).not.toHaveBeenCalled();
    expect(whatsappCloudIsConfigured).not.toHaveBeenCalled();
  });

  it("tells an unconfigured bridge workspace to add its credentials", async () => {
    getBridgeCreds.mockRejectedValue(new Error("not configured"));
    const r = await checkWhatsappReadiness({
      subAccountId: "sa_1",
      subAccount: sub("bridge"),
    });
    expect(r).toMatchObject({ ready: false, provider: "bridge" });
    if (!r.ready) expect(r.error).toContain("Settings → WhatsApp");
    // No point health-checking a URL we do not have.
    expect(bridgeHealth).not.toHaveBeenCalled();
  });

  it("distinguishes an unreachable bridge from a disconnected one", async () => {
    // Three failures, three fixes. Collapsing them sends an operator to the
    // settings page when the number actually needs re-pairing.
    getBridgeCreds.mockResolvedValue({
      baseUrl: "http://b:1",
      token: "t",
      webhookSecret: "w",
    });
    bridgeHealth.mockResolvedValue({
      reachable: false,
      connected: false,
      killed: false,
      number: null,
    });
    const down = await checkWhatsappReadiness({
      subAccountId: "sa_1",
      subAccount: sub("bridge"),
    });
    expect(down.ready).toBe(false);
    if (!down.ready) expect(down.error).toContain("reachable");

    bridgeHealth.mockResolvedValue({
      reachable: true,
      connected: false,
      killed: false,
      number: null,
    });
    const stale = await checkWhatsappReadiness({
      subAccountId: "sa_1",
      subAccount: sub("bridge"),
    });
    expect(stale.ready).toBe(false);
    if (!stale.ready) {
      expect(stale.error).toContain("Re-pair");
      expect(stale.error).not.toContain("reachable");
    }
  });

  it("falls back to the Twilio check for a missing sub-account", async () => {
    subAccountWhatsappIsConfigured.mockReturnValue(false);
    const r = await checkWhatsappReadiness({
      subAccountId: "sa_1",
      subAccount: null,
    });
    expect(r).toMatchObject({ ready: false, provider: "twilio" });
  });

  it("refuses a connected bridge whose kill switch is on", async () => {
    // The fourth state. The kill switch is deliberate — somebody stopped this
    // number during an incident — but a connected, killed bridge refuses every
    // send at the rail. Reporting ready:true let the composer accept a message
    // and fail it afterwards, which reads as a broken rail rather than as a
    // brake somebody has to decide to release.
    getBridgeCreds.mockResolvedValue({
      baseUrl: "http://b:1",
      token: "t",
      webhookSecret: "w",
    });
    bridgeHealth.mockResolvedValue({
      reachable: true,
      connected: true,
      killed: true,
      number: "+27784356159",
    });
    const r = await checkWhatsappReadiness({
      subAccountId: "sa_1",
      subAccount: { whatsappProvider: "bridge" } as never,
    });
    expect(r.ready).toBe(false);
    expect(r.ready === false && r.error).toMatch(/kill switch/i);
  });
});
