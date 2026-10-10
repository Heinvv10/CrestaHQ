import http from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * twilio-node rethrows the raw AxiosError on a transport failure; its
 * config.headers.Authorization is Basic base64(sid:token). These tests use the
 * REAL SDK against a local server that resets the socket, so the error that
 * reaches us is the genuine AxiosError, credential and all.
 */

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({ doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }) }),
}));
vi.mock("@/lib/server/usage-meter", () => ({ recordUsage: vi.fn(), checkQuota: async () => ({ allowed: true }) }));
const policy = vi.hoisted(() => ({ shared: false }));
vi.mock("@/lib/agency/policy", () => ({ agencyAllowsSharedSms: async () => policy.shared }));

import { buildTwilioClient, getTwilioForSubAccount, sendSms, sendSmsForSubAccount } from "./twilio";
import { sanitizeTwilioTransportError } from "./twilio-safe-http";
import type { SubAccountDoc } from "@/types";

const SID = "ACtestredaction0000000000000000000";
const TOKEN = "super-secret-auth-token-value";
const B64 = Buffer.from(`${SID}:${TOKEN}`).toString("base64");

let server: http.Server;
let baseUrl: string;
beforeAll(async () => {
  server = http.createServer((req) => req.socket.destroy());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
afterEach(() => vi.restoreAllMocks());

function leaks(value: unknown): boolean {
  const dumps = [inspect(value, { depth: 10, showHidden: true }), JSON.stringify(value, Object.getOwnPropertyNames(value as object))];
  return dumps.some((d) => d.includes(B64) || d.includes(TOKEN) || d.includes(SID));
}

describe("Twilio transport errors never carry the credential", () => {
  it("control: the unsanitised SDK error DOES contain the credential", async () => {
    const { default: RequestClient } = await import("twilio/lib/base/RequestClient");
    const raw = twilioWith(new RequestClient());
    const err = await raw.messages.create({ from: "+1", to: "+2", body: "x" }).catch((e) => e);
    expect(leaks(err)).toBe(true);
  });

  it("buildTwilioClient: thrown error is clean and keeps name/message/code", async () => {
    const client = buildTwilioClient(SID, TOKEN);
    client.api.baseUrl = baseUrl;
    const err = await client.messages.create({ from: "+1", to: "+2", body: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(leaks(err)).toBe(false);
    expect(err.message).toBeTruthy();
    expect(err.name).toBeTruthy();
    expect(err.code).toBe("ECONNRESET");
    expect(err).not.toHaveProperty("config");
    expect(err).not.toHaveProperty("request");
    expect(err).not.toHaveProperty("response");
  });

  it("sendSmsForSubAccount: console.error of the caught error writes no credential", async () => {
    const sub = {
      agencyId: "ag1",
      twilioConfig: { enabled: true, accountSid: SID, authToken: TOKEN, fromNumber: "+15017122661" },
    } as unknown as SubAccountDoc;
    const { client } = await getTwilioForSubAccount("sa-redact", sub);
    client.api.baseUrl = baseUrl;
    const spies = (["log", "error", "warn", "info"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    const err = await sendSmsForSubAccount({ subAccountId: "sa-redact", subAccount: sub, to: "+15005550006", body: "hi" }).catch((e) => e);
    console.error("[mctb] text-back send failed", err);
    expect(err).toBeInstanceOf(Error);
    expect(leaks(err)).toBe(false);
    for (const s of spies) for (const call of s.mock.calls) expect(call.map((a) => inspect(a, { depth: 10 })).join(" ")).not.toContain(B64);
    expect(spies[1].mock.calls.length).toBe(1);
  });
});

describe("shared mode (platform-wide env credential)", () => {
  const ENV_SID = "ACenvshared00000000000000000000000";
  const ENV_TOKEN = "platform-wide-env-auth-token";
  const ENV_B64 = Buffer.from(`${ENV_SID}:${ENV_TOKEN}`).toString("base64");
  const envLeaks = (v: unknown) =>
    [inspect(v, { depth: 10, showHidden: true }), JSON.stringify(v, Object.getOwnPropertyNames(v as object))].some(
      (d) => d.includes(ENV_B64) || d.includes(ENV_TOKEN) || d.includes(ENV_SID),
    );

  it("sendSmsForSubAccount (shared) and legacy sendSms throw clean errors", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", ENV_SID);
    vi.stubEnv("TWILIO_AUTH_TOKEN", ENV_TOKEN);
    vi.stubEnv("TWILIO_FROM_NUMBER", "+15017122661");
    policy.shared = true;
    try {
      const sub = { agencyId: "ag1" } as unknown as SubAccountDoc;
      const resolved = await getTwilioForSubAccount("sa-shared", sub);
      expect(resolved.mode).toBe("shared");
      resolved.client.api.baseUrl = baseUrl; // the cached env client, also used by sendSms
      const viaSub = await sendSmsForSubAccount({ subAccountId: "sa-shared", subAccount: sub, to: "+15005550006", body: "hi" }).catch((e) => e);
      const legacy = await sendSms({ to: "+15005550006", body: "hi" }).catch((e) => e);
      for (const err of [viaSub, legacy]) {
        expect(err).toBeInstanceOf(Error);
        expect(err.code).toBe("ECONNRESET");
        expect(envLeaks(err)).toBe(false);
      }
    } finally {
      policy.shared = false;
      vi.unstubAllEnvs();
    }
  });
});

describe("sanitizeTwilioTransportError", () => {
  const axiosShaped = Object.assign(new Error("timeout of 30000ms exceeded"), {
    name: "AxiosError",
    code: "ECONNABORTED",
    status: 504,
    config: { headers: { Authorization: `Basic ${B64}` } },
    request: { _header: `Authorization: Basic ${B64}` },
    response: { config: { headers: { Authorization: `Basic ${B64}` } } },
  });

  it("keeps name, message, code, status; drops everything else", () => {
    const safe = sanitizeTwilioTransportError(axiosShaped) as Error & { code?: unknown; status?: unknown };
    expect(safe.name).toBe("AxiosError");
    expect(safe.message).toBe("timeout of 30000ms exceeded");
    expect(safe.code).toBe("ECONNABORTED");
    expect(safe.status).toBe(504);
    expect(leaks(safe)).toBe(false);
  });

  it("preserves a numeric Twilio code (21610 opt-out check)", () => {
    expect((sanitizeTwilioTransportError(Object.assign(new Error("x"), { code: 21610 })) as Error & { code: number }).code).toBe(21610);
  });

  it("tolerates non-Error throwables", () => {
    expect(sanitizeTwilioTransportError(undefined).message).toBe("Twilio request failed");
    expect(sanitizeTwilioTransportError("boom").message).toBe("boom");
  });
});

function twilioWith(httpClient: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const twilio = require("twilio");
  const c = twilio(SID, TOKEN, { httpClient });
  c.api.baseUrl = baseUrl;
  return c as ReturnType<typeof buildTwilioClient>;
}
