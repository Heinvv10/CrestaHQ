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
