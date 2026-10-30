import { describe, it, expect } from "vitest";
import {
  resolveBridgeCreds,
  BridgeNotConfiguredError,
} from "./bridge-credentials";

describe("resolveBridgeCreds", () => {
  const good = {
    baseUrl: "http://100.96.203.105:33001",
    token: "tok_abc",
    webhookSecret: "whsec_abc",
  };

  it("returns the credentials when all three are present", () => {
    expect(resolveBridgeCreds(good, "sa_1")).toEqual(good);
  });

  it("throws when never connected", () => {
    expect(() => resolveBridgeCreds(null, "sa_1")).toThrow(
      BridgeNotConfiguredError,
    );
  });

  it("names the sub-account in the error so a multi-tenant log is diagnosable", () => {
    expect(() => resolveBridgeCreds(null, "sa_velocity")).toThrow(/sa_velocity/);
  });

  it.each(["baseUrl", "token", "webhookSecret"] as const)(
    "throws when %s is missing",
    (field) => {
      expect(() =>
        resolveBridgeCreds({ ...good, [field]: undefined }, "sa_1"),
      ).toThrow(BridgeNotConfiguredError);
    },
  );

  it.each(["baseUrl", "token", "webhookSecret"] as const)(
    "throws when %s is blank rather than calling with an empty value",
    (field) => {
      expect(() =>
        resolveBridgeCreds({ ...good, [field]: "   " }, "sa_1"),
      ).toThrow(BridgeNotConfiguredError);
    },
  );

  it("trims surrounding whitespace from pasted values", () => {
    expect(
      resolveBridgeCreds(
        {
          baseUrl: " http://b:1 ",
          token: " tok \n",
          webhookSecret: " whsec \n",
        },
        "sa_1",
      ),
    ).toEqual({ baseUrl: "http://b:1", token: "tok", webhookSecret: "whsec" });
  });

  it("rejects a malformed baseUrl rather than letting fetch fail opaquely", () => {
    // `fetch("not-a-url/v1/send")` throws "Failed to parse URL", which names
    // nothing an operator can act on.
    expect(() =>
      resolveBridgeCreds({ ...good, baseUrl: "not-a-url" }, "sa_1"),
    ).toThrow(BridgeNotConfiguredError);
  });

  it("rejects a non-http scheme", () => {
    expect(() =>
      resolveBridgeCreds({ ...good, baseUrl: "ftp://host/x" }, "sa_1"),
    ).toThrow(BridgeNotConfiguredError);
  });

  it("strips a trailing slash so call sites can concatenate /v1/send", () => {
    // "http://host//v1/send" is not a path Go's mux routes.
    expect(
      resolveBridgeCreds({ ...good, baseUrl: "http://host:1/" }, "sa_1").baseUrl,
    ).toBe("http://host:1");
  });
});
