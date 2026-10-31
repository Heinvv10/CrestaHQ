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
const { recordBroadcastEmailLookup } = await import("@/lib/comms/email-events");

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

const sendRef = () => mem.db.doc("broadcasts/b1/sends/c1");
const broadcastRef = () => mem.db.doc("broadcasts/b1");
const claimed = (claimId: string) => ({ sendRef: sendRef(), broadcastRef: broadcastRef(), claimId }) as never;
const queue = (extra: Record<string, unknown> = {}) =>
  mem.seed("broadcasts/b1/sends/c1", { agencyId: "ag1", subAccountId: "sa1", contactId: "c1", toEmail: ADDRESS, status: "queued", claimId: "A", ...extra });

/** Breaker round 2: side effects once per row, late retries, upgrades. */
describe("breaker round 2", () => {
  it("A stale replay (fresh svix-id) of a complaint must not re-opt-out a re-subscribed contact", async () => {
    expect((await POST(signed(ev("email.complained")))).status).toBe(200);
    expect(mem.read("contacts/c1")!.emailOptedOut).toBe(true);
    // admin re-subscribes the contact and clears the suppression
    mem.seed("contacts/c1", { ...mem.read("contacts/c1")!, emailOptedOut: false });
    await mem.db.doc(suppressionPath("sa1", ADDRESS)).delete();
    expect((await POST(signed(ev("email.complained")))).status).toBe(200);
    expect(mem.read("contacts/c1")!.emailOptedOut).toBe(false);
  });
  it("A2 same svix-id replayed after the 24h marker is swept re-opts-out too", async () => {
    await POST(signed(ev("email.complained"), { id: "msg_x" }));
    mem.seed("contacts/c1", { ...mem.read("contacts/c1")!, emailOptedOut: false });
    await mem.db.doc("resendWebhookDeliveries/msg_x").delete();
    await POST(signed(ev("email.complained"), { id: "msg_x" }));
    expect(mem.read("contacts/c1")!.emailOptedOut).toBe(false);
  });
  it("B replayed hard bounce re-adds a suppression an admin removed", async () => {
    await POST(signed(ev("email.bounced", hard)));
    await mem.db.doc(suppressionPath("sa1", ADDRESS)).delete();
    await POST(signed(ev("email.bounced", hard)));
    expect(mem.read(suppressionPath("sa1", ADDRESS))).toBeUndefined();
  });
  it("D a legit retry after a failed suppression write still lands opt-out + suppression", async () => {
    const orig = mem.db.doc.bind(mem.db);
    const spy = vi.spyOn(mem.db, "doc").mockImplementation(((p: string) => {
      const r = orig(p);
      if (p.includes("emailSuppressions")) r.create = async () => { throw new Error("blip"); };
      return r;
    }) as typeof mem.db.doc);
    const r1 = await POST(signed(ev("email.complained"), { id: "msg_d" }));
    spy.mockRestore();
    expect(r1.status).toBe(500);
    const r2 = await POST(signed(ev("email.complained"), { id: "msg_d" }));
    expect(r2.status).toBe(200);
    expect(mem.read("contacts/c1")!.emailOptedOut).toBe(true);
    expect(mem.read(suppressionPath("sa1", ADDRESS))).toBeDefined();
    expect(totals().complained).toBe(1);
  });
  it("E superseded claim cannot stamp id or write lookup", async () => {
    queue({ claimId: "B" });
    await recordBroadcastEmailLookup({ row: claimed("A"), emailId: EMAIL2, toEmail: ADDRESS, subAccountId: "sa1", agencyId: "ag1" });
    expect(row().resendMessageId).toBeUndefined();
    expect(mem.read(`emailEvents/${EMAIL2}`)).toBeUndefined();
  });
  it("E2 after a settled row, a late lookup call (same claim) cannot rewrite the id", async () => {
    await recordBroadcastEmailLookup({ row: claimed("A"), emailId: EMAIL2, toEmail: ADDRESS, subAccountId: "sa1", agencyId: "ag1" });
    expect(row().resendMessageId).toBe(EMAIL);
    expect(mem.read(`emailEvents/${EMAIL2}`)).toBeUndefined();
  });
  it("E3 stamp then reclaim by B: E1 event is not 500-looping once B settles with E2", async () => {
    queue();
    await recordBroadcastEmailLookup({ row: claimed("A"), emailId: EMAIL2, toEmail: ADDRESS, subAccountId: "sa1", agencyId: "ag1" });
    const ev2 = { type: "email.delivered", data: { email_id: EMAIL2 } };
    expect((await POST(signed(ev2, { id: "msg_e3" }))).status).toBe(500);
    expect(mem.read("resendWebhookDeliveries/msg_e3")).toBeUndefined();
    mem.seed("broadcasts/b1/sends/c1", { ...row(), status: "sent" });
    expect((await POST(signed(ev2, { id: "msg_e3" }))).status).toBe(200);
    expect(row().deliveredAt).toBeDefined();
  });
  it("G1 queued row stuck then marked failed (interrupted) with the stamped id: event answers 200, not a loop", async () => {
    queue({ resendMessageId: EMAIL });
    expect((await POST(signed(ev("email.bounced", hard), { id: "msg_g1" }))).status).toBe(500);
    mem.seed("broadcasts/b1/sends/c1", { ...row(), status: "failed" });
    expect((await POST(signed(ev("email.bounced", hard), { id: "msg_g1" }))).status).toBe(200);
  });
  it("G2 …and the hard bounce of an email that DID go out is still suppressed", async () => {
    queue({ resendMessageId: EMAIL });
    mem.seed("broadcasts/b1/sends/c1", { ...row(), status: "failed" });
    await POST(signed(ev("email.bounced", hard)));
    expect(mem.read(suppressionPath("sa1", ADDRESS))).toBeDefined();
  });
  it("G2b a failed row with the id takes bounce/complaint effects but no counts, deliveries, opens or clicks", async () => {
    mem.seed("broadcasts/b1/sends/c1", { ...row(), status: "failed" });
    for (const body of [ev("email.delivered"), ev("email.opened"), ev("email.clicked", { click: { link: "https://shop.example/x" } })]) {
      expect((await POST(signed(body))).status).toBe(200);
    }
    await POST(signed(ev("email.complained")));
    expect(mem.read("contacts/c1")!.emailOptedOut).toBe(true);
    expect(mem.read(suppressionPath("sa1", ADDRESS))).toMatchObject({ reason: "complaint" });
    expect(row()).toMatchObject({ status: "failed" });
    expect(row().deliveredAt).toBeUndefined();
    expect(row().openedAt).toBeUndefined();
    expect(row().clickedAt).toBeUndefined();
    expect(totals()).toEqual({ sent: 1 });
  });
  it("G3 queued row with a different id stamped: 200 (no loop)", async () => {
    queue({ resendMessageId: EMAIL2 });
    expect((await POST(signed(ev("email.delivered")))).status).toBe(200);
  });
  it("G4 unstamped queued row; an opened event also 500s and deletes marker", async () => {
    queue();
    const r = await POST(signed(ev("email.opened"), { id: "msg_g4" }));
    expect(r.status).toBe(500);
    expect(mem.read("resendWebhookDeliveries/msg_g4")).toBeUndefined();
  });
  it("F upgrade: transient, permanent, permanent, transient, delivered => counted once, flagged once", async () => {
    await POST(signed(ev("email.bounced", { bounce: { type: "Transient" } })));
    await POST(signed(ev("email.bounced", hard)));
    await POST(signed(ev("email.bounced", hard)));
    await POST(signed(ev("email.bounced", { bounce: { type: "Transient" } })));
    await POST(signed(ev("email.delivered")));
    expect(totals().bounced).toBe(1);
    expect(totals().delivered ?? 0).toBe(0);
    expect(row().hardBounce).toBe(true);
    expect(mem.read("contacts/c1")!.emailBouncedAt).toBeDefined();
    expect(activities().length).toBe(2);
  });
  it("F2 permanent first then transient does not downgrade", async () => {
    await POST(signed(ev("email.bounced", hard)));
    await POST(signed(ev("email.bounced", { bounce: { type: "Transient" } })));
    expect(row().hardBounce).toBe(true);
    expect(String(row().bounceReason)).toContain("No such user");
  });
  it("F3 concurrent permanent + permanent counts once", async () => {
    await Promise.all([POST(signed(ev("email.bounced", hard))), POST(signed(ev("email.bounced", hard)))]);
    expect(totals().bounced).toBe(1);
  });
  it("F4 legacy bounced row without hardBounce field gets upgraded once and not double counted", async () => {
    mem.seed("broadcasts/b1/sends/c1", { ...row(), bouncedAt: new Date(), bounceReason: "x" });
    mem.seed("broadcasts/b1", { ...mem.read("broadcasts/b1")!, totals: { sent: 1, bounced: 1 } });
    await POST(signed(ev("email.bounced", hard)));
    expect(totals().bounced).toBe(1);
  });
  it("H complaint after bounce counts and opts out; complaint twice (new ids) counts once", async () => {
    await POST(signed(ev("email.bounced", hard)));
    await POST(signed(ev("email.complained")));
    await POST(signed(ev("email.complained")));
    expect(totals().complained).toBe(1);
    expect(mem.read("contacts/c1")!.emailOptedOut).toBe(true);
    expect(activities().filter((a) => a.type === "email_complained").length).toBe(1);
  });
});
