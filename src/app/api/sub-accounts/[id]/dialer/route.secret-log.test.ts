import { inspect } from "node:util";
import twilio from "twilio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Breaker repro (PR #385 round 4, R7): a failed Twilio REST call rejects with
 * the raw AxiosError, whose `config.headers.Authorization` is
 * `Basic base64(accountSid:authToken)`. Logging that object writes the
 * sub-account's Twilio credential to the server log.
 *
 * The real twilio SDK and its real RequestClient run here; only axios's
 * network adapter is replaced, with one that rejects the way a refused
 * connection does (the first test proves the credential is in that error). Nothing the route logs or returns may carry the credential.
 */

const ACCOUNT_SID = "AC0000000000000000000000000000dead";
const AUTH_TOKEN = "tok_private_must_never_be_logged";
const BASIC = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64");

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({
    getUser: async () => ({ customClaims: { status: "active", agencyId: "ag1", agencyRole: "staff" } }),
  }),
}));
vi.mock("@/lib/comms/twilio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/comms/twilio")>()),
  buildTwilioClient: (sid: string, token: string) => {
    const client = twilio(sid, token);
    const http = client.httpClient as unknown as {
      axios: { defaults: { adapter: (config: unknown) => Promise<never> } };
    };
    // What axios rejects with on a refused connection: an error carrying the
    // request config axios built — the real one, Authorization header included.
    // (axios is the SDK's dependency, not ours, so AxiosError is not imported.)
    http.axios.defaults.adapter = async (config) => {
      throw Object.assign(new Error("connect ECONNREFUSED"), {
        name: "AxiosError",
        code: "ECONNREFUSED",
        isAxiosError: true,
        config,
      });
    };
    return client;
  },
}));

const route = await import("./route");

function req(method: "POST" | "DELETE") {
  return route[method](
    new Request("https://crm.example.test/api/sub-accounts/sa1/dialer", {
      method,
      headers: { "x-user-uid": "admin" },
    }),
    { params: Promise.resolve({ id: "sa1" }) },
  );
}

const METHODS = ["log", "info", "warn", "error", "debug"] as const;
let spies: Array<ReturnType<typeof vi.spyOn>>;
const logged = () =>
  spies.flatMap((s) => s.mock.calls.flat()).map((a) => inspect(a, { depth: 12, breakLength: Infinity })).join("\n");

beforeEach(() => {
  mem.clear();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.example.test");
  mem.seed("subAccounts/sa1", {
    agencyId: "ag1",
    dialerEnabledByAgency: true,
    twilioConfig: { enabled: true, accountSid: ACCOUNT_SID, authTokenSet: true, fromNumber: "+15017122661" },
  });
  mem.seed("subAccounts/sa1/private/twilioCredentials", { authToken: AUTH_TOKEN });
  mem.seed("subAccounts/sa1/subAccountMembers/admin", { role: "admin", status: "active" });
  spies = METHODS.map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
});
afterEach(() => vi.restoreAllMocks());

describe("dialer provisioning — a failed Twilio call never logs the credential", () => {
  it("the error the SDK rejects with really does carry the Basic credential", async () => {
    const { buildTwilioClient } = await import("@/lib/comms/twilio");
    const err = await buildTwilioClient(ACCOUNT_SID, AUTH_TOKEN).applications("AP1").remove().catch((e: unknown) => e);
    expect(inspect(err, { depth: 12 })).toContain(BASIC);
  });

  it("DELETE: both failed removes are logged without it", async () => {
    mem.seed("subAccounts/sa1/private/dialer", { apiKeySid: "SK1", apiKeySecret: "s", twimlAppSid: "AP1" });
    expect((await req("DELETE")).status).toBe(200);
    const out = logged();
    expect(out).toContain("TwiML App remove failed");
    expect(out).toContain("API key remove failed");
    expect(out).not.toContain(BASIC);
    expect(out).not.toContain(AUTH_TOKEN);
  });

  it("POST: the 502 body and the log are both free of it", async () => {
    const res = await req("POST");
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).not.toContain(BASIC);
    expect(body).not.toContain(AUTH_TOKEN);
    expect(logged()).not.toContain(BASIC);
  });
});
