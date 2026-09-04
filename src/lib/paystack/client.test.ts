import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Guards on the Paystack HTTP envelope.
 *
 * Paystack answers a refused request with HTTP 200 and `status: false`, so a
 * client that trusts the status code treats "Plan code is invalid" as success
 * and hands the operator a checkout URL that does not exist.
 */

const { paystackRequest, paystackIsConfigured } = await import("./client");
const { BillingError } = await import("@/lib/billing/errors");

const fetchMock = vi.fn();
const previousKey = process.env.PAYSTACK_SECRET_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  process.env.PAYSTACK_SECRET_KEY = "sk_test_1";
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousKey === undefined) delete process.env.PAYSTACK_SECRET_KEY;
  else process.env.PAYSTACK_SECRET_KEY = previousKey;
});

function respond(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

describe("paystackIsConfigured", () => {
  it("treats a blank key as absent", () => {
    process.env.PAYSTACK_SECRET_KEY = "   ";
    expect(paystackIsConfigured()).toBe(false);
  });
});

describe("paystackRequest", () => {
  it("fails on status:false even when the HTTP code is 200", async () => {
    respond(200, { status: false, message: "Plan code is invalid" });
    await expect(paystackRequest("GET", "/plan/x")).rejects.toThrow(
      /Plan code is invalid/,
    );
  });

  it("passes Paystack's own message through to the operator", async () => {
    respond(400, { status: false, message: "Customer not found" });
    await expect(paystackRequest("GET", "/customer/x")).rejects.toMatchObject({
      status: 400,
      message: "Paystack: Customer not found",
    });
  });

  it("reports a provider outage as a 502, not the caller's fault", async () => {
    respond(503, { status: false, message: "Service unavailable" });
    await expect(paystackRequest("GET", "/plan")).rejects.toMatchObject({
      status: 502,
    });
  });

  it("refuses to run without a secret key", async () => {
    process.env.PAYSTACK_SECRET_KEY = "";
    await expect(paystackRequest("GET", "/plan")).rejects.toBeInstanceOf(
      BillingError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("authorizes with the secret key and returns the data envelope", async () => {
    respond(200, { status: true, data: { plan_code: "PLN_1" } });
    const data = await paystackRequest<{ plan_code: string }>("POST", "/plan", {
      name: "Growth",
    });
    expect(data).toEqual({ plan_code: "PLN_1" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(
      (init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer sk_test_1");
  });

  it("turns an unreachable host into a BillingError, not an unhandled throw", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(paystackRequest("GET", "/plan")).rejects.toMatchObject({
      status: 502,
    });
  });
});
