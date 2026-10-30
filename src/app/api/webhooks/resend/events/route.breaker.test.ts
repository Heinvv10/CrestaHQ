import { createHash, createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Breaker findings on PR #460 (adopted from the breaker's suite), through the
 * real route, Svix check and handler over an in-memory Firestore: complaints
 * after bounces, retries of the writes that must not be lost, events that
 * arrive before the step settled the row, bounce upgrades, the address the
 * email was actually sent to, and loosely typed payloads.
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

const { POST } = await import("@/app/api/webhooks/resend/events/route");

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
    toEmail: ADDRESS,
  });
}

const row = () => mem.read("broadcasts/b1/sends/c1")!;
const totals = () => mem.read("broadcasts/b1")!.totals as Record<string, number>;
const activities = () => mem.list("contacts/c1/activities");
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


/** Fails every `update` on contacts/* until restored. */
function failContactUpdates() {
  const origCollection = mem.db.collection.bind(mem.db);
  return vi.spyOn(mem.db, "collection").mockImplementation(((name: string) => {
    const col = origCollection(name);
    if (name !== "contacts") return col;
    const origDoc = col.doc.bind(col);
    col.doc = ((id: string) => {
      const d = origDoc(id);
      d.update = async () => {
        throw new Error("firestore blip");
      };
      return d;
    }) as typeof col.doc;
    return col;
  }) as typeof mem.db.collection);
}

describe("breaker — complaints and bounces", () => {
  it("R1 a complaint on a row that already bounced still counts and opts the contact out", async () => {
    expect((await POST(signed(ev("email.bounced", { bounce: { type: "Transient" } })))).status).toBe(200);
    expect((await POST(signed(ev("email.complained")))).status).toBe(200);
    expect(mem.read("contacts/c1")!.emailOptedOut).toBe(true);
    expect(row().complainedAt).toBeDefined();
    expect(totals().complained).toBe(1);
    expect(mem.read(suppressionPath("sa1", ADDRESS))).toMatchObject({ reason: "complaint" });
  });

  it("R2 a failed opt-out answers 500, frees the svix-id, and the retry opts out though the row already complained", async () => {
    const spy = failContactUpdates();
    const res = await POST(signed(ev("email.complained"), { id: "msg_r2" }));
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(mem.read("resendWebhookDeliveries/msg_r2")).toBeUndefined();
    expect(row().complainedAt).toBeDefined();
    expect(mem.read("contacts/c1")!.emailOptedOut).toBe(false);
    expect((await POST(signed(ev("email.complained"), { id: "msg_r2" }))).status).toBe(200);
    expect(mem.read("contacts/c1")!.emailOptedOut).toBe(true);
    expect(totals().complained).toBe(1);
  });

  it("R5 a permanent bounce after a transient one suppresses, flags the contact and records it, counted once", async () => {
    await POST(signed(ev("email.bounced", { bounce: { type: "Transient" } })));
    expect(mem.read("contacts/c1")!.emailBouncedAt).toBeUndefined();
    await POST(signed(ev("email.bounced", hard)));
    expect(mem.read(suppressionPath("sa1", ADDRESS))).toMatchObject({ reason: "hard_bounce" });
    expect(mem.read("contacts/c1")!.emailBouncedAt).toBeDefined();
    expect(row()).toMatchObject({ hardBounce: true, bounceReason: "Permanent · General · No such user" });
    expect(totals().bounced).toBe(1);
    expect(activities().map((a) => a.meta)).toEqual([
      expect.objectContaining({ hardBounce: false }),
      expect.objectContaining({ hardBounce: true }),
    ]);
    // A second permanent report changes nothing more.
    await POST(signed(ev("email.bounced", hard)));
    expect(activities()).toHaveLength(2);
  });

  it("R6 a complaint opts the contact out even after they changed address (intended: they asked this workspace to stop)", async () => {
    mem.seed("contacts/c1", { agencyId: "ag1", subAccountId: "sa1", email: "new@example.co.za", emailOptedOut: false });
    await POST(signed(ev("email.complained")));
    expect(mem.read("contacts/c1")!.emailOptedOut).toBe(true);
    // The suppression is the address the complaint was about, not the new one.
    expect(mem.read(suppressionPath("sa1", ADDRESS))).toMatchObject({ reason: "complaint" });
    expect(mem.read(suppressionPath("sa1", "new@example.co.za"))).toBeUndefined();
  });

  it("R13 a manual suppression is not overwritten by a hard bounce", async () => {
    mem.seed(suppressionPath("sa1", ADDRESS), { reason: "manual", email: ADDRESS });
    await POST(signed(ev("email.bounced", hard)));
    expect(mem.read(suppressionPath("sa1", ADDRESS))!.reason).toBe("manual");
  });
});

describe("breaker — the address actually sent to", () => {
  it("suppresses and flags the lookup's sent address, not the row's fan-out snapshot", async () => {
    const SENT = "thandi.new@example.co.za";
    // Fan-out snapshotted the old address; the step sent to the live one.
    mem.seed("broadcasts/b1/sends/c1", { ...row(), toEmail: ADDRESS });
    mem.seed(`emailEvents/${EMAIL}`, { ...mem.read(`emailEvents/${EMAIL}`), toEmail: SENT });
    mem.seed("contacts/c1", { ...mem.read("contacts/c1"), email: SENT });
    await POST(signed(ev("email.bounced", hard)));
    expect(mem.read(suppressionPath("sa1", SENT))).toMatchObject({ reason: "hard_bounce", email: SENT });
    expect(mem.read(suppressionPath("sa1", ADDRESS))).toBeUndefined();
    expect(mem.read("contacts/c1")!.emailBouncedAt).toBeDefined();
  });

  it("ignores a lookup with no sent address", async () => {
    const lookup = { ...mem.read(`emailEvents/${EMAIL}`) };
    delete lookup.toEmail;
    mem.seed(`emailEvents/${EMAIL}`, lookup);
    const before = data();
    await POST(signed(ev("email.bounced", hard)));
    expect(data()).toBe(before);
  });
});

describe("breaker — an event before the step settled the row", () => {
  for (const [label, patch] of [
    ["queued with the Resend id", { resendMessageId: EMAIL }],
    ["queued with no Resend id yet", { resendMessageId: null }],
  ] as const) {
    it(`R3 ${label}: 500, svix-id freed, nothing written; the retry after the settle lands`, async () => {
      mem.seed("broadcasts/b1/sends/c1", { ...row(), status: "queued", claimId: "x", ...patch });
      for (const [id, body] of [["msg_r3_b", ev("email.bounced", hard)], ["msg_r3_o", ev("email.opened")]] as const) {
        const before = data();
        const res = await POST(signed(body, { id }));
        expect(res.status).toBe(500);
        expect(mem.read(`resendWebhookDeliveries/${id}`)).toBeUndefined();
        expect(data()).toBe(before);
      }
      mem.seed("broadcasts/b1/sends/c1", { ...row(), status: "sent", resendMessageId: EMAIL });
      expect((await POST(signed(ev("email.bounced", hard), { id: "msg_r3_b" }))).status).toBe(200);
      expect(totals().bounced).toBe(1);
    });
  }

  it("a queued row carrying another Resend id is not waited for", async () => {
    mem.seed("broadcasts/b1/sends/c1", { ...row(), status: "queued", resendMessageId: EMAIL2 });
    expect((await POST(signed(ev("email.delivered")))).status).toBe(200);
    expect((await POST(signed(ev("email.opened")))).status).toBe(200);
  });
});

describe("breaker — payload shape and transport", () => {
  it("leaves no replay marker for a body that is not JSON or not a tracked event", async () => {
    for (const [id, body] of [
      ["msg_nj", "not json"],
      ["msg_rx", { type: "email.received", data: { email_id: EMAIL } }],
      ["msg_null", "null"],
    ] as const) {
      expect((await POST(signed(body, { id }))).status).toBe(200);
      expect(mem.read(`resendWebhookDeliveries/${id}`)).toBeUndefined();
    }
  });

  it("R7 an array email_id is ignored, not used as a doc path", async () => {
    // The Admin SDK throws on a non-string doc id (the fake would coerce it).
    const origCollection = mem.db.collection.bind(mem.db);
    vi.spyOn(mem.db, "collection").mockImplementation(((name: string) => {
      const col = origCollection(name);
      const origDoc = col.doc.bind(col);
      col.doc = ((id?: unknown) => {
        if (id !== undefined && typeof id !== "string") throw new Error("documentPath must be a string");
        return origDoc(id as string | undefined);
      }) as typeof col.doc;
      return col;
    }) as typeof mem.db.collection);
    const before = data();
    const res = await POST(signed({ type: "email.delivered", data: { email_id: [EMAIL] } }));
    expect(res.status).toBe(200);
    expect(data()).toBe(before);
  });

  it("R8 a non-string bounce field is ignored, not a 500 loop", async () => {
    const res = await POST(signed(ev("email.bounced", { bounce: { type: 5, message: { x: 1 } } })));
    expect(res.status).toBe(200);
    expect(row()).toMatchObject({ bounceReason: "bounced", hardBounce: false });
    expect(mem.read(suppressionPath("sa1", ADDRESS))).toBeUndefined();
  });

  it("R9 one valid v1 signature among several still verifies", async () => {
    const r = signed(ev("email.delivered"));
    const sig = r.headers.get("svix-signature")!;
    const req = new Request(r.url, {
      method: "POST",
      headers: { "svix-id": r.headers.get("svix-id")!, "svix-timestamp": r.headers.get("svix-timestamp")!, "svix-signature": `v1,AAAA ${sig}` },
      body: await r.text(),
    });
    expect((await POST(req)).status).toBe(200);
  });

  it("R10 a signature under another version only is rejected", async () => {
    const r = signed(ev("email.delivered"));
    const sig = r.headers.get("svix-signature")!.replace("v1,", "v2,");
    const req = new Request(r.url, {
      method: "POST",
      headers: { "svix-id": r.headers.get("svix-id")!, "svix-timestamp": r.headers.get("svix-timestamp")!, "svix-signature": sig },
      body: await r.text(),
    });
    expect((await POST(req)).status).toBe(401);
  });

  it("R11 a chunked body past the cap with no content-length is 413", async () => {
    const before = everything();
    const big = new Uint8Array(70 * 1024).fill(97);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(big.slice(0, 40000));
        c.enqueue(big.slice(40000));
        c.close();
      },
    });
    const req = new Request("https://app.test/x", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect((await POST(req)).status).toBe(413);
    expect(everything()).toBe(before);
  });

  it("R12 two concurrent deliveries of one svix-id process once", async () => {
    const body = ev("email.delivered");
    const [a, b] = await Promise.all([POST(signed(body, { id: "msg_c" })), POST(signed(body, { id: "msg_c" }))]);
    expect(totals().delivered).toBe(1);
    expect([a.status, b.status]).toEqual([200, 200]);
  });
});
