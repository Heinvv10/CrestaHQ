import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ensureVapiPhoneNumber says which number a resource was registered from
 * when it (re)registers one (the Twilio number of that moment), and nothing
 * when it only rebinds an existing resource (its number is unchanged).
 */

const { ensureVapiPhoneNumber } = await import("./vapi");

type Call = { url: string; method: string };
let calls: Call[] = [];
function respond(handler: (c: Call) => { status: number; body: unknown }) {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const c = { url, method: init.method ?? "GET" };
    calls.push(c);
    const r = handler(c);
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
}
const input = (existingPhoneNumberId: string | null) => ({
  subAccountId: "sa1",
  twilioConfig: { enabled: true, accountSid: "AC1", authTokenSet: true, fromNumber: "+27870000001" } as never,
  authToken: "tok",
  assistantId: "asst1",
  existingPhoneNumberId,
});

beforeEach(() => {
  calls = [];
  vi.stubEnv("VAPI_API_KEY", "vapi_test");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("ensureVapiPhoneNumber", () => {
  it("registering a new resource returns its id and the number it was registered from", async () => {
    respond(() => ({ status: 201, body: { id: "pn_new" } }));
    expect(await ensureVapiPhoneNumber(input(null))).toEqual({ phoneNumberId: "pn_new", number: "+27870000001" });
  });

  it("rebinding the stored resource returns no number (it still rings from its own)", async () => {
    respond(() => ({ status: 200, body: {} }));
    expect(await ensureVapiPhoneNumber(input("pn_old"))).toEqual({ phoneNumberId: "pn_old" });
  });

  it("self-heal onto an already-registered resource for this number returns that number", async () => {
    respond((c) =>
      c.method === "POST"
        ? { status: 400, body: { message: "Existing Phone Number has identical twilioAccountSid and number" } }
        : c.method === "GET"
          ? { status: 200, body: [{ id: "pn_found", number: "+27870000001" }] }
          : { status: 200, body: {} }
    );
    expect(await ensureVapiPhoneNumber(input(null))).toEqual({ phoneNumberId: "pn_found", number: "+27870000001" });
  });
});
