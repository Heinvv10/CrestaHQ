import { describe, expect, it } from "vitest";
import {
  buildLaunchpadChecklist,
  type LaunchpadCounts,
  type LaunchpadSubAccount,
} from "./checklist";

const emptySub: LaunchpadSubAccount = {};
const zeroCounts: LaunchpadCounts = {
  contacts: 0,
  forms: 0,
  activeWorkflows: 0,
  bookingPages: 0,
  googleCalendarConnected: false,
};

function itemFor(id: string, sub: LaunchpadSubAccount, counts: LaunchpadCounts) {
  const item = buildLaunchpadChecklist(sub, counts).find((i) => i.id === id);
  if (!item) throw new Error(`no launchpad item ${id}`);
  return item;
}

describe("buildLaunchpadChecklist", () => {
  it("returns all 7 items, none done for an empty sub-account", () => {
    const items = buildLaunchpadChecklist(emptySub, zeroCounts);
    expect(items).toHaveLength(7);
    expect(items.every((i) => !i.done)).toBe(true);
  });

  describe("email", () => {
    it("is not done with no provider set", () => {
      expect(itemFor("email", emptySub, zeroCounts).done).toBe(false);
    });

    it("is done on SMTP with a verified config", () => {
      const sub: LaunchpadSubAccount = {
        emailProvider: "smtp",
        smtpConfig: { verifiedAt: "2026-09-01T00:00:00.000Z" },
      };
      expect(itemFor("email", sub, zeroCounts).done).toBe(true);
    });

    it("is not done on SMTP selected but never verified", () => {
      const sub: LaunchpadSubAccount = {
        emailProvider: "smtp",
        smtpConfig: { verifiedAt: null },
      };
      expect(itemFor("email", sub, zeroCounts).done).toBe(false);
    });

    it("is done on a verified Resend sending domain", () => {
      const sub: LaunchpadSubAccount = { resendConfig: { status: "verified" } };
      expect(itemFor("email", sub, zeroCounts).done).toBe(true);
    });

    it("is not done on a pending or failed Resend domain", () => {
      expect(
        itemFor("email", { resendConfig: { status: "pending" } }, zeroCounts).done,
      ).toBe(false);
      expect(
        itemFor("email", { resendConfig: { status: "failed" } }, zeroCounts).done,
      ).toBe(false);
    });
  });

  describe("whatsapp", () => {
    it("is done with a connected Cloud number", () => {
      const sub: LaunchpadSubAccount = {
        whatsappCloudMeta: { phoneNumberId: "123" },
      };
      expect(itemFor("whatsapp", sub, zeroCounts).done).toBe(true);
    });

    it("is done with a paired bridge sender", () => {
      const sub: LaunchpadSubAccount = {
        whatsappBridgeMeta: { displayPhoneNumber: "+27784356159" },
      };
      expect(itemFor("whatsapp", sub, zeroCounts).done).toBe(true);
    });

    it("is not done with a disconnected Cloud meta (null id)", () => {
      const sub: LaunchpadSubAccount = {
        whatsappCloudMeta: { phoneNumberId: null },
      };
      expect(itemFor("whatsapp", sub, zeroCounts).done).toBe(false);
    });

    it("is not done with a disconnected bridge meta (null number)", () => {
      const sub: LaunchpadSubAccount = {
        whatsappBridgeMeta: { displayPhoneNumber: null },
      };
      expect(itemFor("whatsapp", sub, zeroCounts).done).toBe(false);
    });
  });

  describe("gbp", () => {
    it("is done when googleConnectionMeta.connected is true", () => {
      const sub: LaunchpadSubAccount = { googleConnectionMeta: { connected: true } };
      expect(itemFor("gbp", sub, zeroCounts).done).toBe(true);
    });

    it("is not done when googleConnectionMeta is null", () => {
      const sub: LaunchpadSubAccount = { googleConnectionMeta: null };
      expect(itemFor("gbp", sub, zeroCounts).done).toBe(false);
    });

    it("is not done when connected is explicitly false-shaped (absent)", () => {
      const sub: LaunchpadSubAccount = { googleConnectionMeta: {} };
      expect(itemFor("gbp", sub, zeroCounts).done).toBe(false);
    });
  });

  describe("calendar", () => {
    it("is done with at least one booking page", () => {
      const counts: LaunchpadCounts = { ...zeroCounts, bookingPages: 1 };
      expect(itemFor("calendar", emptySub, counts).done).toBe(true);
    });

    it("is done with a connected Google Calendar and no booking pages", () => {
      const counts: LaunchpadCounts = { ...zeroCounts, googleCalendarConnected: true };
      expect(itemFor("calendar", emptySub, counts).done).toBe(true);
    });

    it("is not done with neither", () => {
      expect(itemFor("calendar", emptySub, zeroCounts).done).toBe(false);
    });
  });

  describe("contacts / forms / workflows counts", () => {
    it("flip done at exactly 1", () => {
      expect(
        itemFor("contacts", emptySub, { ...zeroCounts, contacts: 1 }).done,
      ).toBe(true);
      expect(
        itemFor("forms", emptySub, { ...zeroCounts, forms: 1 }).done,
      ).toBe(true);
      expect(
        itemFor("workflows", emptySub, { ...zeroCounts, activeWorkflows: 1 }).done,
      ).toBe(true);
    });

    it("stay not-done at 0", () => {
      expect(itemFor("contacts", emptySub, zeroCounts).done).toBe(false);
      expect(itemFor("forms", emptySub, zeroCounts).done).toBe(false);
      expect(itemFor("workflows", emptySub, zeroCounts).done).toBe(false);
    });
  });
});
