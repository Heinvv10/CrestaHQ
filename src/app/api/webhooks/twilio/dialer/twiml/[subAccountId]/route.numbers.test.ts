import { beforeEach, describe, expect, it, vi } from "vitest";
import twilio from "twilio";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Which number the dialer TwiML webhook will dial, and when a voice opt-out
 * stops it — through the real POST on an in-memory Firestore (same doubles as
 * route.test.ts). Breaker repros from the PR #385 reviews, kept permanent.
 *
 * Pins: the contact's phone must be a valid number with NO default region
 * ("+…" form) — a local-format number is refused, never guessed at; a number
 * with no country is never dialled; the Voice channel's allowedCountries is
 * honoured; only the E.164 is dialled; and a voice opt-out is per contact.
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

const withPhone = (phone: string) => mem.seed("contacts/c1", { ...mem.read("contacts/c1"), phone });
const allowOnly = (countries: string[]) =>
  mem.seed("subAccounts/sa1/aiAgent/voice", { voice: { allowedCountries: countries } });

describe("dialer TwiML webhook — the number dialled", () => {
  it("never dials an unparseable or invalid number, or one carrying XML", async () => {
    // "+27821234567890" and "+33123" parse WITH a country and are still not
    // valid numbers — the validity check alone must stop them.
    for (const phone of ["1-900-PAYME-NOW", "+447700900123", "+27821234567890", "+33123", "+1555</Number><Number>+19005550100"]) {
      withPhone(phone);
      const body = await (await call(placed())).text();
      expect(body, phone).not.toContain("<Dial");
      expect(body).not.toContain("<Number>+19005550100");
    }
    expect(activity()).toBeUndefined();
  });

  it("refuses a number not in international form, whatever the workspace phone region", async () => {
    for (const region of [undefined, "ZA", "US"]) {
      for (const phone of ["082 123 4567", "0821234567", "27821234567", "0027821234567", "(500) 555-0006"]) {
        seed({ defaultPhoneCountry: region });
        withPhone(phone);
        const body = await (await call(placed())).text();
        expect(body, `${phone} in ${region}`).not.toContain("<Dial");
        expect(body).toContain("international format");
      }
    }
    expect(activity()).toBeUndefined();
  });

  it("refuses a +… number embedded in anything but the strict form, before it is parsed", async () => {
    // Each of these parses to a valid number on its own; the strict-form rule
    // is the only thing that stops them.
    for (const phone of [
      "tel:+27821234567",
      "Mobile: +27821234567",
      "x+27821234567",
      "\u200B+27821234567",
      "\u202E+27821234567",
      "+\u200B27821234567",
      "\uFF0B27821234567",
      "+27821234567 / +442079460958",
      "+27 82 123 4567 ext. 99",
    ]) {
      withPhone(phone);
      const body = await (await call(placed())).text();
      expect(body, JSON.stringify(phone)).not.toContain("<Dial");
      expect(body).toContain("international format");
    }
    expect(activity()).toBeUndefined();
  });

  it("dials a strict-form number written with separators", async () => {
    for (const phone of [" +27 82 123 4567 ", "+27.82.123.4567", "+(27) 821234567"]) {
      withPhone(phone);
      expect(await (await call(placed())).text(), phone).toContain("<Number>+27821234567</Number>");
    }
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
});

describe("dialer TwiML webhook — voice opt-out is per contact", () => {
  it("refuses the opted-out contact; a duplicate contact with the same number is not blocked", async () => {
    mem.seed("contacts/c1", { ...mem.read("contacts/c1"), voiceOptedOut: true });
    mem.seed("contacts/c1dup", { subAccountId: "sa1", agencyId: "ag1", phone: CONTACT_PHONE, territoryId: "t1" });
    expect(await (await call(placed())).text()).not.toContain("<Dial");
    expect(await (await call(placed({ contactId: "c1dup" }))).text()).toContain("<Dial");
  });
});
