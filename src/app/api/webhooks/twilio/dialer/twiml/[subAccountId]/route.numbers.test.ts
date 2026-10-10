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
 * honoured; only the E.164 is dialled; an opted-out contact whose stored
 * digits name the same number blocks the call whatever its spelling; and past
 * the scan cap the call is refused.
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
    for (const phone of ["1-900-PAYME-NOW", "+447700900123", "+1555</Number><Number>+19005550100"]) {
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

describe("dialer TwiML webhook — voice opt-out belongs to the number", () => {
  const optedOut = (id: string, phone: unknown, sa = "sa1") =>
    mem.seed(`contacts/${id}`, { subAccountId: sa, agencyId: "ag1", phone, voiceOptedOut: true });

  it("refuses when another contact in this sub-account with the same number opted out", async () => {
    mem.seed("contacts/c1", { ...mem.read("contacts/c1"), voiceOptedOut: true });
    mem.seed("contacts/c1dup", { subAccountId: "sa1", agencyId: "ag1", phone: CONTACT_PHONE, territoryId: "t1" });
    expect(await (await call(placed({ contactId: "c1dup" }))).text()).not.toContain("<Dial");
  });

  it("a sibling's opt-out blocks in every spelling of the number, for each dialable spelling", async () => {
    const SIBLING = [
      "+27821234567",
      "27821234567",
      "082 123 4567",
      "0821234567",
      "+27 82 123 4567",
      "082-123-4567",
      "(082) 123 4567",
      "0027821234567",
      "+27 82 123 4567 ext. 12",
      "0821234567x9",
    ];
    for (const dialled of ["+27821234567", "+27 82 123 4567", "+27 (82) 123-4567"]) {
      for (const sibling of SIBLING) {
        mem.clear();
        seed();
        withPhone(dialled);
        expect(await (await call(placed())).text(), `${dialled} alone`).toContain("<Number>+27821234567</Number>");
        optedOut("sib", sibling);
        expect(await (await call(placed())).text(), `${dialled} vs ${sibling}`).not.toContain("<Dial");
      }
    }
  });

  it("does not block on a different number, a short digit overlap, a blank phone or another sub-account", async () => {
    withPhone("+27821234567");
    optedOut("o1", "+27821234568");
    optedOut("o2", "234567"); // 6 digits: under the 7-digit floor
    optedOut("o3", "");
    optedOut("o4", null);
    optedOut("o5", "+27821234567", "sa2");
    expect(await (await call(placed())).text()).toContain("<Number>+27821234567</Number>");
  });

  it("a national number under 7 digits matches on the whole E.164 only, never as a substring", async () => {
    withPhone("+6834002"); // Niue: national number "4002"
    optedOut("o1", "+27114002000"); // contains 4002 — another number entirely
    expect(await (await call(placed())).text()).toContain("<Number>+6834002</Number>");
    optedOut("o2", "(683) 4002");
    expect(await (await call(placed())).text()).not.toContain("<Dial");
  });

  it("fails closed past the scan cap: refuses and warns, even though no opted-out contact matches", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let i = 0; i < 2000; i += 1) optedOut(`o${String(i).padStart(4, "0")}`, `+2711000${String(i).padStart(4, "0")}`);
    expect(await (await call(placed())).text()).toContain("<Dial"); // exactly the cap: all read, none match
    optedOut("o2000", "+27110009999");
    const body = await (await call(placed({ CallSid: "CA0002" }))).text();
    expect(body).not.toContain("<Dial");
    expect(body).toContain("opt-out list");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("opt_out_scan_over_cap"))).toBe(true);
    expect(mem.read("contacts/c1/activities/dialer_CA0002")).toBeUndefined();
    warn.mockRestore();
  });

  it("a match beyond the first page is still found", async () => {
    for (let i = 0; i < 700; i += 1) optedOut(`o${String(i).padStart(4, "0")}`, `+2711000${String(i).padStart(4, "0")}`);
    optedOut("zzz", "(500) 555-0006");
    expect(await (await call(placed())).text()).not.toContain("<Dial");
  });
});
