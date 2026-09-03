import { describe, it, expect } from "vitest";
import {
  resolveWabaCreds,
  WabaNotConfiguredError,
} from "./cloud-credentials";

describe("resolveWabaCreds", () => {
  const good = {
    phoneNumberId: "1234567890",
    wabaId: "9876543210",
    accessToken: "EAAG...",
  };

  it("returns the credentials when all three are present", () => {
    expect(resolveWabaCreds(good, "sa_1")).toEqual(good);
  });

  it("throws when never connected", () => {
    expect(() => resolveWabaCreds(null, "sa_1")).toThrow(
      WabaNotConfiguredError,
    );
  });

  it("names the sub-account in the error so a multi-tenant log is diagnosable", () => {
    expect(() => resolveWabaCreds(null, "sa_velocity")).toThrow(/sa_velocity/);
  });

  it.each(["phoneNumberId", "wabaId", "accessToken"] as const)(
    "throws when %s is missing",
    (field) => {
      expect(() =>
        resolveWabaCreds({ ...good, [field]: undefined }, "sa_1"),
      ).toThrow(WabaNotConfiguredError);
    },
  );

  it.each(["phoneNumberId", "wabaId", "accessToken"] as const)(
    "throws when %s is blank rather than sending with an empty id",
    (field) => {
      // A blank phoneNumberId builds the URL
      // graph.facebook.com/v23.0//messages, which 404s with an opaque error.
      // Failing here names the actual problem.
      expect(() =>
        resolveWabaCreds({ ...good, [field]: "   " }, "sa_1"),
      ).toThrow(WabaNotConfiguredError);
    },
  );

  it("trims surrounding whitespace from a pasted token", () => {
    // Tokens are pasted from the Meta dashboard and routinely carry a trailing
    // newline. An untrimmed token produces a 401 that looks like a revoked
    // credential.
    expect(
      resolveWabaCreds(
        { phoneNumberId: " 1 ", wabaId: " 9 ", accessToken: " EAAG \n" },
        "sa_1",
      ),
    ).toEqual({ phoneNumberId: "1", wabaId: "9", accessToken: "EAAG" });
  });
});
