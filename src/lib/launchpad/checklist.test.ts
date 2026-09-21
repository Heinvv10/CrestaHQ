import { describe, expect, it } from "vitest";
import {
  buildLaunchpadChecklist,
  type LaunchpadCounts,
  type LaunchpadSubAccount,
  type LaunchpadViewer,
} from "./checklist";

const emptySub: LaunchpadSubAccount = {};
const zeroCounts: LaunchpadCounts = {
  contacts: 0,
  forms: 0,
  activeWorkflows: 0,
  bookingPages: 0,
  googleCalendarConnected: false,
  whatsappConnected: false,
};
const admin: LaunchpadViewer = { isAdmin: true };
const nonAdmin: LaunchpadViewer = { isAdmin: false };

function itemFor(
  id: string,
  sub: LaunchpadSubAccount,
  counts: LaunchpadCounts,
  viewer: LaunchpadViewer = admin,
) {
  const item = buildLaunchpadChecklist(sub, counts, viewer).find((i) => i.id === id);
  if (!item) throw new Error(`no launchpad item ${id}`);
  return item;
}

describe("buildLaunchpadChecklist", () => {
  it("returns all 7 items, none done for an empty sub-account", () => {
    const items = buildLaunchpadChecklist(emptySub, zeroCounts, admin);
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

    describe("availability", () => {
      it("is available to an admin even with the domain gate off (SMTP has no gate)", () => {
        const item = itemFor("email", { emailDomainEnabledByAgency: false }, zeroCounts, admin);
        expect(item.available).toBe(true);
        expect(item.reason).toBeNull();
      });

      it("is unavailable to a non-admin viewer, with a reason", () => {
        const item = itemFor("email", emptySub, zeroCounts, nonAdmin);
        expect(item.available).toBe(false);
        expect(item.reason).toBe("Only a workspace admin can set this up.");
      });

      it("stays available once done, even for a non-admin viewer", () => {
        const sub: LaunchpadSubAccount = { resendConfig: { status: "verified" } };
        const item = itemFor("email", sub, zeroCounts, nonAdmin);
        expect(item.done).toBe(true);
        expect(item.available).toBe(true);
        expect(item.reason).toBeNull();
      });
    });
  });

  describe("whatsapp", () => {
    // This item reads `counts.whatsappConnected`, computed by the launchpad
    // API route through `whatsappSenderConfigured()` — the same function
    // readiness/composer/settings already resolve through — rather than by
    // this module inspecting Cloud/bridge meta directly, which would miss a
    // Twilio-only workspace (see route.ts's comment). The route's own
    // Twilio/Cloud/bridge/none coverage lives in route.test.ts; this only
    // needs to prove the item passes the boolean through unchanged.
    it("is done when the route reports a configured sender", () => {
      const counts: LaunchpadCounts = { ...zeroCounts, whatsappConnected: true };
      expect(itemFor("whatsapp", emptySub, counts).done).toBe(true);
    });

    it("is not done when the route reports no configured sender", () => {
      expect(itemFor("whatsapp", emptySub, zeroCounts).done).toBe(false);
    });

    it("is always available (out of scope for the gating review round)", () => {
      expect(itemFor("whatsapp", emptySub, zeroCounts, nonAdmin).available).toBe(true);
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

    describe("availability", () => {
      it("is unavailable when the agency gate is off, with a reason", () => {
        const item = itemFor("gbp", { googleEnabledByAgency: false }, zeroCounts, admin);
        expect(item.available).toBe(false);
        expect(item.reason).toBe("Turned off by your agency.");
      });

      it("is unavailable to a non-admin viewer even with the gate on", () => {
        const item = itemFor(
          "gbp",
          { googleEnabledByAgency: true },
          zeroCounts,
          nonAdmin,
        );
        expect(item.available).toBe(false);
        expect(item.reason).toBe("Only a workspace admin can set this up.");
      });

      it("is available to an admin with the gate on", () => {
        const item = itemFor("gbp", { googleEnabledByAgency: true }, zeroCounts, admin);
        expect(item.available).toBe(true);
        expect(item.reason).toBeNull();
      });

      it("stays available once done, even with the gate later turned off", () => {
        const sub: LaunchpadSubAccount = {
          googleConnectionMeta: { connected: true },
          googleEnabledByAgency: false,
        };
        const item = itemFor("gbp", sub, zeroCounts, nonAdmin);
        expect(item.done).toBe(true);
        expect(item.available).toBe(true);
        expect(item.reason).toBeNull();
      });
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
