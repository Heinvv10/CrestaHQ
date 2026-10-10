import { beforeEach, describe, expect, it, vi } from "vitest";
import twilio from "twilio";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The dialer TwiML webhook through the real POST → readSubAccountSecret →
 * twilio.validateRequest → requireContactAccessible, on an in-memory
 * Firestore. Only Firebase Auth's getUser (custom claims) is stubbed.
 *
 * Pins: the signature is checked against the token in
 * `private/twilioCredentials` (not the legacy parent field); the agency gate
 * refuses; the number dialled is the contact doc's, never a request param;
 * voiceOptedOut and cross-tenant contacts never reach <Dial>; recording is off
 * unless the sub-account turned it on.
 */

const mem = createMemoryFirestore();
const claims = vi.hoisted(() => ({}) as Record<string, Record<string, unknown>>);
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({
    getUser: async (uid: string) => ({ customClaims: claims[uid] ?? {} }),
  }),
}));

const { POST } = await import("./route");

const BASE = "https://crm.example.test/api/webhooks/twilio/dialer/twiml";
const CONTACT_PHONE = "+15005550006";
const FROM_NUMBER = "+15017122661";

function seed(over: Record<string, unknown> = {}) {
  mem.seed("subAccounts/sa1", {
    agencyId: "ag1",
    dialerEnabledByAgency: true,
    dialerConfig: { enabled: true, recordCalls: false },
    twilioConfig: { enabled: true, accountSid: "AC_sa1", authTokenSet: true, fromNumber: FROM_NUMBER },
    ...over,
  });
  mem.seed("subAccounts/sa1/private/twilioCredentials", { authToken: "tok_private" });
  mem.seed("subAccounts/sa1/subAccountMembers/u1", { role: "collaborator", status: "active" });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", phone: CONTACT_PHONE, territoryId: "t1" });
  mem.seed("contacts/c_other", { subAccountId: "sa2", agencyId: "ag1", phone: "+15005550007" });
  claims.u1 = { status: "active", agencyId: "ag1", agencyRole: "staff" };
  claims.owner = { status: "active", agencyId: "ag1", agencyRole: "owner" };
  claims.stranger = { status: "active", agencyId: "ag9", agencyRole: "staff" };
}

function call(
  params: Record<string, string>,
  opts: { token?: string; signature?: string | null; sa?: string } = {},
) {
  const url = `${BASE}/${opts.sa ?? "sa1"}`;
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  const signature =
    opts.signature === undefined
      ? twilio.getExpectedTwilioSignature(opts.token ?? "tok_private", url, params)
      : opts.signature;
  if (signature !== null) headers["x-twilio-signature"] = signature;
  return POST(
    new Request(url, { method: "POST", headers, body: new URLSearchParams(params).toString() }),
    { params: Promise.resolve({ subAccountId: opts.sa ?? "sa1" }) },
  );
}

const placed = (over: Record<string, string> = {}) => ({
  CallSid: "CA0001",
  From: "client:u1",
  To: "+19995550100",
  contactId: "c1",
  ...over,
});

const activity = () => mem.read("contacts/c1/activities/dialer_CA0001");

beforeEach(() => {
  mem.clear();
  for (const k of Object.keys(claims)) delete claims[k];
  seed();
});

describe("dialer TwiML webhook — signature", () => {
  it("validates against the private-doc token and dials", async () => {
    const res = await call(placed());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<Dial");
  });

  it("a request signed with the legacy parent token is 403 when the private doc holds another", async () => {
    mem.seed("subAccounts/sa1", {
      ...mem.read("subAccounts/sa1"),
      twilioConfig: { enabled: true, accountSid: "AC_sa1", authToken: "tok_legacy", fromNumber: FROM_NUMBER },
    });
    const res = await call(placed(), { token: "tok_legacy" });
    expect(res.status).toBe(403);
    expect(activity()).toBeUndefined();
  });

  it("a missing or forged signature is 403 and writes nothing", async () => {
    expect((await call(placed(), { signature: null })).status).toBe(403);
    expect((await call(placed(), { signature: "forged" })).status).toBe(403);
    expect((await call(placed(), { token: "tok_wrong" })).status).toBe(403);
    expect(activity()).toBeUndefined();
  });

  it("a sub-account with no Twilio token is 404", async () => {
    expect((await call(placed(), { sa: "sa_none" })).status).toBe(404);
  });
});

describe("dialer TwiML webhook — guards", () => {
  it("gate off is 403 even with a valid signature, and nothing is dialled", async () => {
    seed({ dialerEnabledByAgency: false });
    const res = await call(placed());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "gate_off" });
    expect(activity()).toBeUndefined();
  });

  it("dials the contact doc's phone, never the To the browser sent", async () => {
    const body = await (await call(placed({ To: "+19995550100", phone: "+19995550101" }))).text();
    expect(body).toContain(`<Number>${CONTACT_PHONE}</Number>`);
    expect(body).toContain(`callerId="${FROM_NUMBER}"`);
    expect(body).not.toContain("+19995550100");
    expect(body).not.toContain("+19995550101");
    expect(activity()).toMatchObject({ type: "call_placed", createdBy: "u1" });
  });

  it("refuses a voiceOptedOut contact without dialling", async () => {
    mem.seed("contacts/c1", { ...mem.read("contacts/c1"), voiceOptedOut: true });
    const body = await (await call(placed())).text();
    expect(body).toContain("opted out");
    expect(body).toContain("<Hangup");
    expect(body).not.toContain("<Dial");
    expect(activity()).toBeUndefined();
  });

  it("refuses a contact from another sub-account, even for the agency owner", async () => {
    for (const From of ["client:u1", "client:owner"]) {
      const body = await (await call(placed({ contactId: "c_other", From }))).text();
      expect(body).not.toContain("<Dial");
    }
    expect(mem.read("contacts/c_other/activities/dialer_CA0001")).toBeUndefined();
  });

  it("refuses a caller who is not a member, or not from the dialer at all", async () => {
    for (const From of ["client:stranger", "+15005550008", ""]) {
      const body = await (await call(placed({ From }))).text();
      expect(body).not.toContain("<Dial");
    }
    expect(activity()).toBeUndefined();
  });

  it("refuses a collaborator calling a contact outside their territory", async () => {
    seed({ territoryScopingEnabled: true });
    mem.seed("subAccounts/sa1/subAccountMembers/u1", {
      role: "collaborator",
      status: "active",
      assignedTerritoryIds: ["t2"],
    });
    expect(await (await call(placed())).text()).not.toContain("<Dial");
    mem.seed("subAccounts/sa1/subAccountMembers/u1", {
      role: "collaborator",
      status: "active",
      assignedTerritoryIds: ["t1"],
    });
    expect(await (await call(placed())).text()).toContain("<Dial");
  });

  it("does not record unless recordCalls is on", async () => {
    expect(await (await call(placed())).text()).not.toContain("record=");
    seed({ dialerConfig: { enabled: true } });
    expect(await (await call(placed())).text()).not.toContain("record=");
    seed({ dialerConfig: { enabled: true, recordCalls: true } });
    expect(await (await call(placed())).text()).toContain('record="record-from-answer-dual"');
  });

  it("a disabled dialer is refused in TwiML", async () => {
    seed({ dialerConfig: null });
    expect(await (await call(placed())).text()).not.toContain("<Dial");
  });
});

// Breaker repros from the PR #385 review, kept as permanent tests.
describe("dialer TwiML webhook — number checks (shared with the AI voice path)", () => {
  const withPhone = (phone: string) => mem.seed("contacts/c1", { ...mem.read("contacts/c1"), phone });
  const allowOnly = (countries: string[]) =>
    mem.seed("subAccounts/sa1/aiAgent/voice", { voice: { allowedCountries: countries } });

  it("never dials an unparseable or invalid number, or one carrying XML", async () => {
    for (const phone of ["1-900-PAYME-NOW", "+447700900123", "+1555</Number><Number>+19005550100"]) {
      withPhone(phone);
      const body = await (await call(placed())).text();
      expect(body, phone).not.toContain("<Dial");
      expect(body).not.toContain("<Number>+19005550100");
    }
    expect(activity()).toBeUndefined();
  });

  it("dials the normalised E.164, not the stored string", async () => {
    withPhone("+1 (500) 555-0006");
    expect(await (await call(placed())).text()).toContain(`<Number>${CONTACT_PHONE}</Number>`);
  });

  it("R1a: a non-geographic number (+882, +800) is never dialled, with no allow-list set", async () => {
    for (const phone of ["+88216000000", "+80012345678"]) {
      withPhone(phone);
      expect(await (await call(placed())).text(), phone).not.toContain("<Dial");
    }
    expect(activity()).toBeUndefined();
  });

  it("honours the Voice channel's allowedCountries", async () => {
    allowOnly(["ZA"]);
    expect(await (await call(placed())).text()).not.toContain("<Dial");
    withPhone("+27821234567");
    expect(await (await call(placed())).text()).toContain("<Number>+27821234567</Number>");
  });

  it("parses a national-format number with the workspace phone region, like the contact write paths", async () => {
    withPhone("082 123 4567");
    expect(await (await call(placed())).text()).not.toContain("<Dial"); // region unset reads as US
    seed({ defaultPhoneCountry: "ZA" });
    withPhone("082 123 4567");
    expect(await (await call(placed())).text()).toContain("<Number>+27821234567</Number>");
    withPhone("+1 (500) 555-0006"); // a "+" number keeps its own country
    expect(await (await call(placed())).text()).toContain(`<Number>${CONTACT_PHONE}</Number>`);
    allowOnly(["US"]); // the allow-list applies to the parsed result
    withPhone("082 123 4567");
    expect(await (await call(placed())).text()).not.toContain("<Dial");
    allowOnly(["ZA"]); // …including a foreign number written with the region's "00" prefix
    withPhone("0044 7911 123456");
    expect(await (await call(placed())).text()).not.toContain("<Dial");
  });

  it("refuses when another contact in this sub-account with the same number opted out", async () => {
    mem.seed("contacts/c1", { ...mem.read("contacts/c1"), voiceOptedOut: true });
    mem.seed("contacts/c1dup", { subAccountId: "sa1", agencyId: "ag1", phone: CONTACT_PHONE, territoryId: "t1" });
    expect(await (await call(placed({ contactId: "c1dup" }))).text()).not.toContain("<Dial");
  });

  it("a sibling's opt-out blocks whichever common format either contact's phone is stored in", async () => {
    const FORMATS = ["+27821234567", "27821234567", "082 123 4567", "0821234567", "+27 82 123 4567"];
    for (const dialled of FORMATS) {
      for (const sibling of FORMATS) {
        mem.clear();
        seed({ defaultPhoneCountry: "ZA" });
        withPhone(dialled);
        expect(await (await call(placed())).text(), `${dialled} alone`).toContain("<Number>+27821234567</Number>");
        mem.seed("contacts/sib", { subAccountId: "sa1", agencyId: "ag1", phone: sibling, voiceOptedOut: true });
        expect(await (await call(placed())).text(), `${dialled} vs ${sibling}`).not.toContain("<Dial");
      }
    }
  });

  it("an opt-out on the same number in ANOTHER sub-account does not block", async () => {
    mem.seed("contacts/x1", { subAccountId: "sa2", agencyId: "ag1", phone: CONTACT_PHONE, voiceOptedOut: true });
    expect(await (await call(placed())).text()).toContain("<Dial");
  });
});

describe("dialer TwiML webhook — breaker controls", () => {
  it("a multi-segment contactId is refused, not resolved to a sub-document", async () => {
    mem.seed("contacts/c1/notes/n1", { subAccountId: "sa1", agencyId: "ag1", phone: "+27821234567" });
    expect(await (await call(placed({ contactId: "c1/notes/n1" }))).text()).not.toContain("<Dial");
  });

  it("a member of both sub-accounts cannot bill sa1 for an sa2 contact", async () => {
    mem.seed("subAccounts/sa2/subAccountMembers/u1", { role: "admin", status: "active" });
    expect(await (await call(placed({ contactId: "c_other" }))).text()).not.toContain("<Dial");
  });

  it("sa2's token, or spoofed host headers, cannot sign into sa1's URL", async () => {
    mem.seed("subAccounts/sa2/private/twilioCredentials", { authToken: "tok_sa2" });
    expect((await call(placed(), { token: "tok_sa2" })).status).toBe(403);
    const params = placed();
    const sig = twilio.getExpectedTwilioSignature("tok_wrong", "http://evil.test/api/webhooks/twilio/dialer/twiml/sa1", params);
    const res = await POST(
      new Request(`${BASE}/sa1`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": sig,
          "x-forwarded-host": "evil.test",
          "x-forwarded-proto": "http",
        },
        body: new URLSearchParams(params).toString(),
      }),
      { params: Promise.resolve({ subAccountId: "sa1" }) },
    );
    expect(res.status).toBe(403);
  });

  it("no secret appears in the TwiML", async () => {
    mem.seed("subAccounts/sa1/private/dialer", { apiKeySid: "SKx", apiKeySecret: "SECRET_api", twimlAppSid: "APx" });
    expect(await (await call(placed())).text()).not.toMatch(/tok_private|SECRET_api/);
  });
});
