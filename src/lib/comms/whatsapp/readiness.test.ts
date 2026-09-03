import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SubAccountDoc } from "@/types";

const whatsappCloudIsConfigured = vi.fn();
const subAccountWhatsappIsConfigured = vi.fn();

vi.mock("./cloud-credentials", () => ({
  whatsappCloudIsConfigured: (...a: unknown[]) => whatsappCloudIsConfigured(...a),
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
  });

  it("checks Twilio credentials for a legacy workspace", async () => {
    subAccountWhatsappIsConfigured.mockReturnValue(true);
    await expect(
      checkWhatsappReadiness({ subAccountId: "sa_1", subAccount: sub() }),
    ).resolves.toEqual({ ready: true, provider: "twilio" });
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
    expect(r).toEqual({ ready: true, provider: "cloud" });
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

  it("refuses the unimplemented bridge rail", async () => {
    const r = await checkWhatsappReadiness({
      subAccountId: "sa_1",
      subAccount: sub("bridge"),
    });
    expect(r).toMatchObject({ ready: false, provider: "bridge" });
    expect(subAccountWhatsappIsConfigured).not.toHaveBeenCalled();
    expect(whatsappCloudIsConfigured).not.toHaveBeenCalled();
  });

  it("falls back to the Twilio check for a missing sub-account", async () => {
    subAccountWhatsappIsConfigured.mockReturnValue(false);
    const r = await checkWhatsappReadiness({
      subAccountId: "sa_1",
      subAccount: null,
    });
    expect(r).toMatchObject({ ready: false, provider: "twilio" });
  });
});
