import { createHash, createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Resend events webhook through the real route, the real Svix check and
 * the real event handler over an in-memory Firestore. Every refusal writes
 * nothing; an event lands only on the send row its lookup names, in the
 * lookup's sub-account, carrying that Resend id.
 */

const mem = await vi.hoisted(async () => {
  const { createMemoryFirestore } = await import("@/test/memory-firestore");
  return createMemoryFirestore();
});
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const KEY = Buffer.from("0123456789abcdef0123456789abcdef");
const SECRET = `whsec_${KEY.toString("base64")}`;
process.env.RESEND_WEBHOOK_SECRET = SECRET;
process.env.NEXT_PUBLIC_APP_URL = "https://app.test";

const { POST } = await import("./route");
const { recordBroadcastEngagement } = await import("@/lib/broadcasts/engagement");

const EMAIL = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";
const EMAIL2 = "9b2c1f00-1111-4222-8333-444455556666";
const ADDRESS = "thandi@example.co.za";
const suppressionPath = (sa: string, email: string) =>
  `subAccounts/${sa}/emailSuppressions/${createHash("sha256").update(email).digest("hex")}`;

let seq = 0;
function signed(
  body: unknown,
  o: { id?: string; ts?: number; key?: Buffer; sign?: string } = {},
): Request {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const id = o.id ?? `msg_${++seq}`;
  const ts = String(o.ts ?? Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", o.key ?? KEY).update(`${id}.${ts}.${o.sign ?? raw}`).digest("base64");
  return new Request("https://app.test/api/webhooks/resend/events", {
    method: "POST",
    headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}`, "content-type": "application/json" },
    body: raw,
  });
}
const ev = (type: string, data: Record<string, unknown> = {}, at = new Date()) => ({
  type,
  created_at: at.toISOString(),
  data: { email_id: EMAIL, ...data },
});
const hard = { bounce: { type: "Permanent", subType: "General", message: "No such user" } };

function seed() {
  mem.clear();
  for (const sa of ["sa1", "sa2"]) {
    mem.seed(`subAccounts/${sa}`, { agencyId: "ag1", emailTracking: { opens: true, clicks: true } });
  }
  mem.seed("contacts/c1", { agencyId: "ag1", subAccountId: "sa1", email: ADDRESS, emailOptedOut: false });
  mem.seed("broadcasts/b1", { agencyId: "ag1", subAccountId: "sa1", templateName: "News", totals: { sent: 1 } });
  mem.seed("broadcasts/b1/sends/c1", {
    agencyId: "ag1",
    subAccountId: "sa1",
    contactId: "c1",
    toEmail: "Thandi@Example.co.za",
    status: "sent",
    resendMessageId: EMAIL,
  });
  mem.seed(`emailEvents/${EMAIL}`, {
    kind: "broadcast",
    broadcastId: "b1",
    contactId: "c1",
    subAccountId: "sa1",
    agencyId: "ag1",
  });
}

const row = () => mem.read("broadcasts/b1/sends/c1")!;
const totals = () => mem.read("broadcasts/b1")!.totals as Record<string, number>;
const activities = () => mem.list("contacts/c1/activities");
const ms = (v: unknown) => (v instanceof Date ? v.getTime() : (v as { toMillis: () => number }).toMillis());
/** The store minus replay markers: what an ignored event must leave alone. */
const data = () => JSON.stringify(mem.all().filter((d) => !d.path.startsWith("resendWebhookDeliveries/")));
const everything = () => JSON.stringify(mem.all());

beforeEach(() => {
  seed();
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/webhooks/resend/events — refusals write nothing", () => {
  it("503 with no secret, or one that is not whsec_ + base64", async () => {
    for (const secret of [undefined, "", "not-a-secret", "whsec_!!"]) {
      if (secret === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
      else process.env.RESEND_WEBHOOK_SECRET = secret;
      const before = everything();
      expect((await POST(signed(ev("email.delivered")))).status).toBe(503);
      expect(everything()).toBe(before);
    }
  });

  it("413 over 64 KB, before any signature work", async () => {
    const before = everything();
    const res = await POST(signed({ ...ev("email.delivered"), pad: "x".repeat(70 * 1024) }));
    expect(res.status).toBe(413);
    expect(everything()).toBe(before);
  });

  it("401 unsigned, wrong secret, tampered body, stale or future timestamp", async () => {
    const before = everything();
    const unsigned = new Request("https://app.test/api/webhooks/resend/events", {
      method: "POST",
      body: JSON.stringify(ev("email.delivered")),
    });
    const now = Math.floor(Date.now() / 1000);
    for (const req of [
      unsigned,
      signed(ev("email.delivered"), { key: Buffer.from("another-secret-of-32-bytes-long!") }),
      signed(ev("email.delivered"), { sign: JSON.stringify(ev("email.opened")) }),
      signed(ev("email.delivered"), { ts: now - 301 }),
      signed(ev("email.delivered"), { ts: now + 301 }),
    ]) {
      expect((await POST(req)).status).toBe(401);
    }
    expect(everything()).toBe(before);
  });

  it("acknowledges a replayed svix-id with 200 ignored, and the replay writes nothing", async () => {
    const body = ev("email.opened");
    expect((await POST(signed(body, { id: "msg_replay" }))).status).toBe(200);
    const after = everything();
    const replay = await POST(signed(body, { id: "msg_replay" }));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, ignored: true });
    expect(everything()).toBe(after);
    expect(row().opens).toBe(1);
  });
});

describe("POST /api/webhooks/resend/events — tenant binding", () => {
  it("ignores a lookup whose sub-account is not the row's", async () => {
    mem.seed(`emailEvents/${EMAIL2}`, { kind: "broadcast", broadcastId: "b1", contactId: "c1", subAccountId: "sa2", agencyId: "ag1" });
    mem.seed("broadcasts/b1/sends/c1", { ...row(), resendMessageId: EMAIL2 });
    const before = data();
    for (const type of ["email.delivered", "email.opened", "email.clicked", "email.complained"]) {
      expect((await POST(signed(ev(type, { email_id: EMAIL2 })))).status).toBe(200);
    }
    expect((await POST(signed(ev("email.bounced", { email_id: EMAIL2, ...hard })))).status).toBe(200);
    expect(data()).toBe(before);
  });

  it("ignores a lookup naming a row that recorded a different Resend id", async () => {
    mem.seed(`emailEvents/${EMAIL2}`, { kind: "broadcast", broadcastId: "b1", contactId: "c1", subAccountId: "sa1", agencyId: "ag1" });
    const before = data();
    await POST(signed(ev("email.bounced", { email_id: EMAIL2, ...hard })));
    await POST(signed(ev("email.opened", { email_id: EMAIL2 })));
    expect(data()).toBe(before);
  });

  it("ignores an email with no lookup (an SMTP send) and a lookup with a path in its ids", async () => {
    // A path-shaped id would address a nested doc that passes every other check.
    const nested = "b0/sends/c0/nested";
    mem.seed(`broadcasts/${nested}`, { agencyId: "ag1", subAccountId: "sa1", totals: {} });
    mem.seed(`broadcasts/${nested}/sends/c1`, { ...row(), resendMessageId: EMAIL2 });
    mem.seed(`emailEvents/${EMAIL2}`, { kind: "broadcast", broadcastId: nested, contactId: "c1", subAccountId: "sa1", agencyId: "ag1" });
    const before = data();
    expect((await POST(signed(ev("email.delivered", { email_id: "no-such-email" })))).status).toBe(200);
    expect((await POST(signed(ev("email.delivered", { email_id: EMAIL2 })))).status).toBe(200);
    expect(data()).toBe(before);
  });
});

describe("POST /api/webhooks/resend/events — delivery events", () => {
  it("delivered stamps the row once and counts the recipient once", async () => {
    const at = new Date(Date.now() - 60_000);
    await POST(signed(ev("email.delivered", {}, at)));
    await POST(signed(ev("email.delivered")));
    expect(ms(row().deliveredAt)).toBe(at.getTime());
    expect(totals().delivered).toBe(1);
    expect(activities()).toEqual([]);
  });

  it("a permanent bounce suppresses the address, flags the contact and ends the row", async () => {
    expect((await POST(signed(ev("email.bounced", hard)))).status).toBe(200);
    expect(mem.read(suppressionPath("sa1", ADDRESS))).toMatchObject({
      agencyId: "ag1",
      subAccountId: "sa1",
      email: ADDRESS,
      reason: "hard_bounce",
      createdByUid: "resend-webhook",
    });
    expect(mem.read("contacts/c1")!.emailBouncedAt).toBeTruthy();
    expect(row()).toMatchObject({ bounceReason: "Permanent · General · No such user" });
    expect(totals().bounced).toBe(1);
    expect(activities()).toHaveLength(1);
    expect(activities()[0]).toMatchObject({ type: "email_bounced", subAccountId: "sa1" });
    // A bounced row takes no further events.
    await POST(signed(ev("email.opened")));
    await POST(signed(ev("email.bounced", hard)));
    expect(row().opens).toBeUndefined();
    expect(totals().bounced).toBe(1);
    expect(activities()).toHaveLength(1);
  });

  it("a transient bounce stamps the row but suppresses nothing", async () => {
    await POST(signed(ev("email.bounced", { bounce: { type: "Transient", subType: "MailboxFull" } })));
    expect(row().bouncedAt).toBeTruthy();
    expect(mem.read(suppressionPath("sa1", ADDRESS))).toBeUndefined();
    expect(mem.read("contacts/c1")!.emailBouncedAt).toBeUndefined();
  });

  it("keeps an existing suppression entry and skips the flag once the contact changed address", async () => {
    mem.seed(suppressionPath("sa1", ADDRESS), { email: ADDRESS, reason: "manual", subAccountId: "sa1" });
    mem.seed("contacts/c1", { ...mem.read("contacts/c1"), email: "new@example.co.za" });
    expect((await POST(signed(ev("email.bounced", hard)))).status).toBe(200);
    expect(mem.read(suppressionPath("sa1", ADDRESS))).toMatchObject({ reason: "manual" });
    expect(mem.read("contacts/c1")!.emailBouncedAt).toBeUndefined();
  });

  it("a complaint suppresses the address and opts the contact out", async () => {
    await POST(signed(ev("email.complained")));
    expect(mem.read(suppressionPath("sa1", ADDRESS))).toMatchObject({ reason: "complaint" });
    expect(mem.read("contacts/c1")!.emailOptedOut).toBe(true);
    expect(totals().complained).toBe(1);
    expect(activities()[0]).toMatchObject({ type: "email_complained" });
  });
});

describe("POST /api/webhooks/resend/events — opens and clicks merge with our pixel", () => {
  it("both sources count, the recipient counts once, and openedAt is the earliest", async () => {
    await recordBroadcastEngagement({ broadcastId: "b1", contactId: "c1", kind: "opened" });
    const pixelAt = ms(row().openedAt);
    const earlier = new Date(pixelAt - 30_000);
    await POST(signed(ev("email.opened", {}, earlier)));
    await POST(signed(ev("email.opened", {}, new Date(pixelAt + 1))));
    expect(row().opens).toBe(3);
    expect(ms(row().openedAt)).toBe(earlier.getTime());
    expect(totals().opened).toBe(1);
    expect(activities().filter((a) => a.type === "email_opened")).toHaveLength(1);
  });

  it("records nothing with tracking switched off, and never counts the unsubscribe link", async () => {
    await POST(signed(ev("email.clicked", { click: { link: "https://app.test/u/c1tok" } })));
    mem.seed("subAccounts/sa1", { agencyId: "ag1", emailTracking: { opens: false, clicks: false } });
    const before = data();
    await POST(signed(ev("email.opened")));
    await POST(signed(ev("email.clicked", { click: { link: "https://shop.example/x" } })));
    expect(data()).toBe(before);
    expect(row().clickedAt).toBeUndefined();
  });
});

describe("POST /api/webhooks/resend/events — failures retry", () => {
  it("a processing failure answers 500 and frees the svix-id for Resend's retry", async () => {
    const tx = vi.spyOn(mem.db, "runTransaction").mockRejectedValueOnce(new Error("unavailable"));
    expect((await POST(signed(ev("email.delivered"), { id: "msg_retry" }))).status).toBe(500);
    expect(mem.read("resendWebhookDeliveries/msg_retry")).toBeUndefined();
    tx.mockRestore();
    expect((await POST(signed(ev("email.delivered"), { id: "msg_retry" }))).status).toBe(200);
    expect(totals().delivered).toBe(1);
  });

  it("a suppression write that failed lands on the retry, though the row already bounced", async () => {
    const doc = mem.db.doc.bind(mem.db);
    const spy = vi.spyOn(mem.db, "doc").mockImplementation((path: string) =>
      path.includes("/emailSuppressions/")
        ? { ...doc(path), create: async () => Promise.reject(new Error("unavailable")) }
        : doc(path),
    );
    expect((await POST(signed(ev("email.bounced", hard), { id: "msg_b" }))).status).toBe(500);
    expect(row().bouncedAt).toBeTruthy();
    expect(mem.read(suppressionPath("sa1", ADDRESS))).toBeUndefined();
    // The contact side effects ran before the failing write.
    expect(mem.read("contacts/c1")!.emailBouncedAt).toBeTruthy();
    expect(activities()).toHaveLength(1);
    spy.mockRestore();
    expect((await POST(signed(ev("email.bounced", hard), { id: "msg_b" }))).status).toBe(200);
    expect(mem.read(suppressionPath("sa1", ADDRESS))).toMatchObject({ reason: "hard_bounce" });
  });

  it("answers 200 to a signed body that is not JSON or not a tracked event", async () => {
    const before = data();
    expect((await POST(signed("not json"))).status).toBe(200);
    expect((await POST(signed({ type: "email.received", data: { email_id: EMAIL } }))).status).toBe(200);
    expect(data()).toBe(before);
  });
});
