import { beforeEach, describe, expect, it, vi } from "vitest";
import twilio from "twilio";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The dialer <Dial action> callback through the real POST →
 * readSubAccountSecret → twilio.validateRequest, on an in-memory Firestore.
 * Pins: the signature is checked against the private-doc token and covers the
 * `?contactId=` query; only a contact in this sub-account is updated; the
 * outcome still lands when the agency gate was switched off mid-call.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { POST } = await import("./route");

const BASE = "https://crm.example.test/api/webhooks/twilio/dialer/status";
const params = { CallSid: "CA0001", DialCallStatus: "completed", DialCallDuration: "65" };

function seed(over: Record<string, unknown> = {}) {
  mem.seed("subAccounts/sa1", {
    agencyId: "ag1",
    dialerEnabledByAgency: true,
    dialerConfig: { enabled: true, recordCalls: false },
    twilioConfig: { enabled: true, accountSid: "AC_sa1", authTokenSet: true, fromNumber: "+15017122661" },
    ...over,
  });
  mem.seed("subAccounts/sa1/private/twilioCredentials", { authToken: "tok_private" });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", phone: "+15005550006" });
  mem.seed("contacts/c_other", { subAccountId: "sa2", agencyId: "ag1", phone: "+15005550007" });
}

function call(
  opts: { token?: string; signature?: string | null; contactId?: string; signedContactId?: string; body?: Record<string, string> } = {},
) {
  const body = opts.body ?? params;
  const url = (cid: string) => `${BASE}/sa1?contactId=${cid}`;
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  const signature =
    opts.signature === undefined
      ? twilio.getExpectedTwilioSignature(
          opts.token ?? "tok_private",
          url(opts.signedContactId ?? opts.contactId ?? "c1"),
          body,
        )
      : opts.signature;
  if (signature !== null) headers["x-twilio-signature"] = signature;
  return POST(
    new Request(url(opts.contactId ?? "c1"), {
      method: "POST",
      headers,
      body: new URLSearchParams(body).toString(),
    }),
    { params: Promise.resolve({ subAccountId: "sa1" }) },
  );
}

const row = (contact = "c1") => mem.read(`contacts/${contact}/activities/dialer_CA0001`);

beforeEach(() => {
  mem.clear();
  seed();
});

describe("dialer status callback", () => {
  it("validates against the private-doc token and records the outcome", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<Hangup");
    expect(row()).toMatchObject({
      type: "call_placed",
      content: "Phone call — 1m 5s",
      meta: { callSid: "CA0001", status: "completed", durationSec: 65 },
      createdBy: "dialer",
    });
  });

  it("a request signed with the legacy parent token is 403 when the private doc holds another", async () => {
    seed({ twilioConfig: { enabled: true, accountSid: "AC_sa1", authToken: "tok_legacy", fromNumber: "+15017122661" } });
    expect((await call({ token: "tok_legacy" })).status).toBe(403);
    expect(row()).toBeUndefined();
  });

  it("a missing, forged or wrong-token signature is 403 and writes nothing", async () => {
    expect((await call({ signature: null })).status).toBe(403);
    expect((await call({ signature: "forged" })).status).toBe(403);
    expect((await call({ token: "tok_wrong" })).status).toBe(403);
    expect(row()).toBeUndefined();
  });

  it("the signature covers the contactId query — swapping it is 403", async () => {
    mem.seed("contacts/c2", { subAccountId: "sa1", agencyId: "ag1", phone: "+15005550009" });
    expect((await call({ contactId: "c2", signedContactId: "c1" })).status).toBe(403);
    expect(row("c2")).toBeUndefined();
  });

  it("never writes to a contact in another sub-account", async () => {
    expect((await call({ contactId: "c_other" })).status).toBe(200);
    expect(row("c_other")).toBeUndefined();
  });

  it("keeps the TwiML route's createdAt/createdBy and adds the recording URL", async () => {
    seed({ dialerConfig: { enabled: true, recordCalls: true } });
    mem.seed("contacts/c1/activities/dialer_CA0001", {
      type: "call_placed",
      createdBy: "u1",
      content: "Phone call — in progress",
    });
    await call({ body: { ...params, DialCallStatus: "no-answer", RecordingUrl: "https://api.twilio.com/rec/RE1" } });
    expect(row()).toMatchObject({
      createdBy: "u1",
      content: "Phone call — no answer",
      meta: { recordingUrl: "https://api.twilio.com/rec/RE1" },
    });
  });

  it("still records the outcome after the gate, or dedicated Twilio, is switched off mid-call", async () => {
    seed({
      dialerEnabledByAgency: false,
      twilioConfig: { enabled: false, accountSid: "AC_sa1", authTokenSet: true, fromNumber: "+15017122661" },
    });
    expect((await call()).status).toBe(200);
    expect(row()).toMatchObject({ content: "Phone call — 1m 5s" });
  });

  it("R8: a path-shaped contactId or CallSid is answered 200 and writes nothing", async () => {
    mem.seed("contacts/c1/notes/n1", { subAccountId: "sa1", agencyId: "ag1" });
    const before = mem.all().length;
    expect((await call({ contactId: "c1/notes/n1" })).status).toBe(200);
    for (const CallSid of ["x/sub/y", "..", "__x__"]) {
      const res = await call({ body: { ...params, CallSid } });
      expect(res.status, CallSid).toBe(200);
      expect(await res.text()).toContain("<Hangup");
    }
    expect(mem.all().length).toBe(before);
  });

  it("R9: a RecordingUrl is stored only with recording on and only from Twilio", async () => {
    const TWILIO_URL = "https://api.twilio.com/2010-04-01/Accounts/AC_sa1/Recordings/RE1";
    const stored = async (RecordingUrl: string) => {
      await call({ body: { ...params, RecordingUrl } });
      return (row()?.meta as { recordingUrl?: string }).recordingUrl;
    };
    expect(await stored(TWILIO_URL)).toBeUndefined(); // recording is off
    seed({ dialerConfig: { enabled: true, recordCalls: true } });
    for (const url of ["https://evil.test/rec.mp3", "javascript:alert(1)", "http://api.twilio.com/x", "https://api.twilio.com.evil.test/x"]) {
      expect(await stored(url), url).toBeUndefined();
    }
    expect(await stored(TWILIO_URL)).toBe(TWILIO_URL);
  });

  it("R9: an unknown status reads as ended — prototype keys included — and the duration is clamped", async () => {
    for (const DialCallStatus of ["constructor", "toString", "__proto__", "<b>pwned</b>", ""]) {
      await call({ body: { ...params, DialCallStatus } });
      expect(row(), DialCallStatus).toMatchObject({ content: "Phone call — ended", meta: { status: "ended" } });
    }
    const duration = async (DialCallDuration: string) => {
      await call({ body: { ...params, DialCallDuration } });
      return (row()?.meta as { durationSec: number }).durationSec;
    };
    expect(await duration("-5")).toBe(0);
    expect(await duration("abc")).toBe(0);
    expect(await duration("1e999")).toBe(0);
    expect(await duration("12.7")).toBe(12);
    expect(await duration("999999999")).toBe(86_400);
  });
});
