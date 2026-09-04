import { describe, it, expect } from "vitest";
import {
  templateRegistration,
  isTemplateApprovedFor,
} from "./template-registrations";

const legacy = {
  contentSid: "HX123",
  status: "approved" as const,
  rejectionReason: null,
};

describe("templateRegistration", () => {
  it("reads the legacy flat fields as the twilio registration", () => {
    // Every template predating the seam has no `registrations` map. Reading
    // them as twilio is what makes this change additive.
    expect(templateRegistration(legacy, "twilio")).toMatchObject({
      externalId: "HX123",
      status: "approved",
    });
  });

  it("does NOT read the legacy fields for cloud", () => {
    // The sharpest guard here. A template approved on Twilio's WABA has never
    // been seen by ours; claiming otherwise sends a template Meta rejects,
    // out of window, leaving the customer unreachable.
    expect(templateRegistration(legacy, "cloud")).toBeNull();
  });

  it("does not read the legacy fields for the bridge", () => {
    expect(templateRegistration(legacy, "bridge")).toBeNull();
  });

  it("prefers an explicit registration over the legacy fields", () => {
    expect(
      templateRegistration(
        {
          ...legacy,
          registrations: {
            twilio: {
              externalId: "HX999",
              status: "rejected",
              rejectionReason: "policy",
            },
          },
        },
        "twilio",
      ),
    ).toMatchObject({ externalId: "HX999", status: "rejected" });
  });

  it("keeps the two rails independent", () => {
    const tpl = {
      ...legacy,
      registrations: {
        cloud: {
          externalId: "1234",
          status: "pending" as const,
          rejectionReason: null,
        },
      },
    };
    expect(isTemplateApprovedFor(tpl, "twilio")).toBe(true);
    expect(isTemplateApprovedFor(tpl, "cloud")).toBe(false);
  });

  it("returns null for a missing template", () => {
    expect(templateRegistration(null, "twilio")).toBeNull();
  });

  it("defaults a legacy doc with no status to draft rather than approved", () => {
    expect(templateRegistration({ contentSid: null }, "twilio")).toMatchObject({
      status: "draft",
    });
  });
});

describe("isTemplateApprovedFor", () => {
  it("is true for an approved registration with an external id", () => {
    expect(isTemplateApprovedFor(legacy, "twilio")).toBe(true);
  });

  it.each(["pending", "rejected", "draft", "paused", "disabled", "failed"] as const)(
    "is false when the status is %s",
    (status) => {
      expect(isTemplateApprovedFor({ ...legacy, status }, "twilio")).toBe(false);
    },
  );

  it("is false when approved but carrying no external id", () => {
    // An approved registration with nothing to send by would push the send
    // path into a template branch it cannot execute.
    expect(
      isTemplateApprovedFor({ ...legacy, contentSid: null }, "twilio"),
    ).toBe(false);
  });

  it("is false when the external id is blank", () => {
    expect(isTemplateApprovedFor({ ...legacy, contentSid: "  " }, "twilio")).toBe(
      false,
    );
  });
});

import {
  buildRegistrationUpdate,
  type WhatsappTemplateRegistration,
} from "./template-registrations";

describe("buildRegistrationUpdate", () => {
  const reg = {
    externalId: "meta-1",
    status: "pending" as const,
    rejectionReason: null,
    pollAttempts: 0,
  };

  it("writes the registration under its own provider key", () => {
    const u = buildRegistrationUpdate({ contentSid: null }, "cloud", reg);
    expect(u["registrations.cloud"]).toEqual(reg);
  });

  it("mirrors status to the flat field so existing UI keeps working", () => {
    // The templates manager renders tpl.status. Without the mirror, a template
    // submitted on the cloud rail would render as "draft" forever.
    const u = buildRegistrationUpdate({ contentSid: null }, "cloud", reg);
    expect(u.status).toBe("pending");
  });

  it("FREEZES the legacy Twilio approval into its own key before the mirror overwrites it", () => {
    // The heart of it. Flat contentSid/status ARE the twilio registration for
    // every pre-seam template. Once the flat status starts mirroring the cloud
    // rail, reading flat as twilio would report cloud's approval as Twilio's.
    // So the legacy values are copied into registrations.twilio first, where
    // the reader prefers them.
    const u = buildRegistrationUpdate(
      { contentSid: "HX1", status: "approved", rejectionReason: null },
      "cloud",
      reg,
    );
    expect(u["registrations.twilio"]).toMatchObject({
      externalId: "HX1",
      status: "approved",
    });
  });

  it("does not clobber an explicit twilio registration that already exists", () => {
    const u = buildRegistrationUpdate(
      {
        contentSid: "HX_stale",
        status: "approved",
        registrations: {
          twilio: {
            externalId: "HX_real",
            status: "rejected",
            rejectionReason: "policy",
          },
        },
      },
      "cloud",
      reg,
    );
    expect(u["registrations.twilio"]).toBeUndefined();
  });

  it("does not invent a twilio registration when there was never a Content SID", () => {
    // A template drafted after the seam has no Twilio history to preserve.
    const u = buildRegistrationUpdate(
      { contentSid: null, status: "draft" },
      "cloud",
      reg,
    );
    expect(u["registrations.twilio"]).toBeUndefined();
  });

  it("keeps writing the flat fields when the provider IS twilio", () => {
    // Twilio's shipped routes still read contentSid; nothing about them
    // changes.
    const u = buildRegistrationUpdate({ contentSid: null }, "twilio", {
      ...reg,
      externalId: "HX2",
    });
    expect(u.contentSid).toBe("HX2");
    expect(u["registrations.twilio"]).toMatchObject({ externalId: "HX2" });
  });

  it("round-trips through the reader so each rail sees only its own state", () => {
    const u = buildRegistrationUpdate(
      { contentSid: "HX1", status: "approved", rejectionReason: null },
      "cloud",
      { ...reg, status: "approved", externalId: "meta-1" },
    );
    const merged = {
      contentSid: "HX1",
      status: u.status as "approved",
      registrations: {
        twilio: u["registrations.twilio"] as WhatsappTemplateRegistration,
        cloud: u["registrations.cloud"] as WhatsappTemplateRegistration,
      },
    };
    expect(isTemplateApprovedFor(merged, "twilio")).toBe(true);
    expect(isTemplateApprovedFor(merged, "cloud")).toBe(true);
    expect(templateRegistration(merged, "twilio")?.externalId).toBe("HX1");
    expect(templateRegistration(merged, "cloud")?.externalId).toBe("meta-1");
  });
});

import { classifyPollTick } from "./template-registrations";

describe("classifyPollTick", () => {
  const pendingOnCloud = {
    contentSid: null,
    status: "pending" as const,
    registrations: {
      cloud: { externalId: "meta-1", status: "pending" as const, rejectionReason: null },
    },
  };

  it("proceeds while the tick still owns the current rail's approval", () => {
    expect(classifyPollTick(pendingOnCloud, "cloud", "meta-1")).toBe("proceed");
  });

  it("reports a rail switch when another rail holds the id being chased", () => {
    // THE TRAP. Switching provider mid-approval used to drop the tick with no
    // reschedule, leaving the template `pending` — a state the UI cannot
    // escape, since submit takes only draft/rejected/failed and delete refuses
    // pending. Only a manual Firestore edit recovered it.
    expect(classifyPollTick(pendingOnCloud, "twilio", "meta-1")).toBe(
      "rail-switched",
    );
  });

  it("detects the switch in the other direction too, via the legacy flat fields", () => {
    const pendingOnTwilio = { contentSid: "HX1", status: "pending" as const };
    expect(classifyPollTick(pendingOnTwilio, "cloud", "HX1")).toBe(
      "rail-switched",
    );
  });

  it("is plain stale when the id belongs to no rail at all", () => {
    // Re-submitted under a new id — the newer poll chain owns it.
    expect(classifyPollTick(pendingOnCloud, "cloud", "meta-OLD")).toBe("stale");
  });

  it.each(["approved", "rejected", "failed", "draft", "paused"] as const)(
    "is stale once the template has settled as %s",
    (status) => {
      expect(
        classifyPollTick({ ...pendingOnCloud, status }, "cloud", "meta-1"),
      ).toBe("stale");
    },
  );

  it("is stale for a template that no longer exists", () => {
    expect(classifyPollTick(null, "cloud", "meta-1")).toBe("stale");
  });

  it("never reports a rail switch when the SAME rail simply moved on", () => {
    // Same rail, newer id: that is a re-submission, not a switch, and must not
    // flip a live template to failed.
    expect(classifyPollTick(pendingOnCloud, "cloud", "meta-old")).toBe("stale");
  });
});
