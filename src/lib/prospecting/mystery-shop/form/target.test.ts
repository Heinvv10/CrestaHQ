import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubAccountDoc } from "@/types";

/** The form channel's availability and the identity the form is filled with. formTargetOf: route.form.test.ts. */

const available = vi.fn();
vi.mock("./engine-image", () => ({ formEngineAvailable: async () => available() }));
const blocked = vi.fn();
vi.mock("./isolation", () => ({ isolationBlocked: async () => blocked() }));
const { formChannelState, formIdentity } = await import("./target");

const MAILBOX = { enabled: true, verifiedAt: "2026-10-01T00:00:00Z", username: "Info@CrestaHQ.com", lastError: null };
const sub = (over: Record<string, unknown> = {}) =>
  ({ name: "Cresta HQ", defaultPhoneCountry: "ZA", mailboxConfig: MAILBOX, ...over }) as unknown as SubAccountDoc;
const enquiry = { subject: "Enquiry: plumber", message: "Hi", service: "plumber", town: "Gqeberha" };

beforeEach(() => {
  available.mockReset().mockReturnValue(true);
  blocked.mockReset().mockReturnValue(false);
});

describe("formChannelState", () => {
  it("needs a working synced mailbox with a known address, then the engine", async () => {
    expect(await formChannelState(sub())).toEqual({ available: true });
    expect(await formChannelState(sub({ mailboxConfig: null }))).toMatchObject({ available: false, reason: expect.stringMatching(/IMAP/) });
    expect(await formChannelState(sub({ mailboxConfig: { ...MAILBOX, verifiedAt: "" } }))).toMatchObject({ available: false });
    expect(await formChannelState(sub({ mailboxConfig: { ...MAILBOX, enabled: false } }))).toMatchObject({ available: false });
    expect(await formChannelState(sub({ mailboxConfig: { ...MAILBOX, lastError: "Login failed." } }))).toEqual({
      available: false, reason: "The mailbox sync is failing: Login failed.",
    });
    expect(await formChannelState(sub({ mailboxConfig: { ...MAILBOX, username: "desk" } }))).toEqual({
      available: false, reason: "The mailbox address isn't known.",
    });
  });

  it("containers that can reach the host keep the channel off (the firewall is required)", async () => {
    blocked.mockReturnValue(true);
    expect(await formChannelState(sub())).toEqual({
      available: false, reason: "The form engine can reach this server: install its host firewall first (RUNBOOK).",
    });
  });

  it("the engine missing is its own reason (the route's 403 channel_unavailable)", async () => {
    available.mockReturnValue(false);
    expect(await formChannelState(sub())).toEqual({ available: false, reason: "The form engine isn't installed on this server." });
  });
});

describe("formIdentity", () => {
  it("is the business name, the synced mailbox address and the Cloud WhatsApp number (whose replies are matched) in E.164", () => {
    expect(formIdentity(sub({ whatsappCloudMeta: { displayPhoneNumber: "+27 78 435 6159" }, whatsappNumber: "082 000 0000" }), enquiry)).toEqual({
      business: "Cresta HQ", email: "info@crestahq.com", phone: "+27784356159", ...enquiry,
    });
  });

  it("falls back to Branding's WhatsApp number; none at all is null (a required phone field then refuses)", () => {
    expect(formIdentity(sub({ whatsappNumber: "078 435 6159" }), enquiry)?.phone).toBe("+27784356159");
    expect(formIdentity(sub({ whatsappNumber: "not a number" }), enquiry)?.phone).toBeNull();
    expect(formIdentity(sub(), enquiry)?.phone).toBeNull();
  });

  it("is null without a mailbox address", () => {
    expect(formIdentity(sub({ mailboxConfig: null }), enquiry)).toBeNull();
  });
});
