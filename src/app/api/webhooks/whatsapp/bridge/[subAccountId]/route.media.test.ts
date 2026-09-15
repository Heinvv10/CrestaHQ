import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signWebhookPayload } from "@/lib/api/webhooks/signing";
import { whatsappMediaPath } from "@/lib/comms/whatsapp/media-storage";

/**
 * Media on the wa-agent-bridge inbound webhook, through `POST` with a correctly
 * signed body and a valid bearer.
 *
 * The fake Firestore here is deliberately slimmer than route.test.ts's: it
 * records the message-row `.set` argument (the thing the back-compat test
 * pins byte for byte), the conversation upsert, the timeline activity, and
 * nothing else. The STOP/START batch is covered next door.
 */

const CREDS = {
  baseUrl: "http://bridge.local:33001",
  token: "tok_secret",
  webhookSecret: "whsec_test",
};

let contactRows: Array<{ id: string; data: Record<string, unknown> }> = [];
let subAccountDoc: Record<string, unknown> | undefined;
let messageWrites: Array<{ contactId: string; docId: string; data: Record<string, unknown> }> = [];
let conversationUpserts: Array<Record<string, unknown>> = [];
let existingMessageIds = new Set<string>();
let inboundActivities = new Map<string, Record<string, unknown>>();

function makeSnap(row: { id: string; data: Record<string, unknown> }) {
  const ref = {
    id: row.id,
    collection: () => ({
      doc: (docId?: string) => ({
        id: docId ?? "generated-id",
        get: async () => ({ exists: existingMessageIds.has(docId ?? "") }),
        set: async (data: Record<string, unknown>) => {
          messageWrites.push({ contactId: row.id, docId: docId ?? "", data });
        },
      }),
    }),
  };
  return { id: row.id, data: () => row.data, ref };
}

const contactsQuery = {
  where: () => contactsQuery,
  limit: () => contactsQuery,
  get: async () => ({
    empty: contactRows.length === 0,
    docs: contactRows.map(makeSnap),
  }),
};

const fakeDb = {
  doc: () => ({ get: async () => ({ data: () => subAccountDoc }) }),
  collection: (name: string) => {
    if (name !== "contacts") throw new Error(`unexpected collection ${name}`);
    return {
      ...contactsQuery,
      doc: (id?: string) => ({
        id: id ?? "generated-contact-id",
        collection: () => ({
          doc: (docId?: string) => ({
            set: async (data: Record<string, unknown>) => {
              inboundActivities.set(`${id}/${docId ?? "auto"}`, data);
            },
          }),
        }),
      }),
    };
  },
  batch: () => {
    throw new Error("no opt-out path in these tests");
  },
};

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => fakeDb }));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "SERVER_TS" },
}));
vi.mock("@/lib/comms/whatsapp/bridge-credentials", () => ({
  getBridgeCreds: async () => CREDS,
}));
vi.mock("@/lib/server/contacts-service", () => ({
  createContactServerSide: async () => {
    throw new Error("not expected");
  },
}));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: async (a: Record<string, unknown>) => {
    conversationUpserts.push(a);
  },
}));
vi.mock("@/lib/comms/ai/openrouter", () => ({ aiIsConfigured: () => false }));
vi.mock("@/lib/comms/ai/agent", () => ({ resolveAgent: async () => null }));
vi.mock("@/lib/comms/ai/respond", () => ({ maybeRespondWithAi: vi.fn() }));

/** The bucket. Only `putWhatsappMedia` is faked — `whatsappMediaPath` is the
 *  real one, so the test asserts the path the serving route will re-derive. */
const putWhatsappMedia = vi.fn();
vi.mock("@/lib/comms/whatsapp/media-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/comms/whatsapp/media-storage")>()),
  putWhatsappMedia: (...a: unknown[]) => putWhatsappMedia(...a),
}));

import { POST } from "./route";

function post(
  payload: Record<string, unknown>,
  opts: { secret?: string } = {},
) {
  const rawBody = JSON.stringify(payload);
  const signed = signWebhookPayload(opts.secret ?? CREDS.webhookSecret, rawBody);
  const headers = new Headers({
    "content-type": "application/json",
    "leadstack-signature": signed.header,
    authorization: `Bearer ${CREDS.token}`,
  });
  return POST(
    new Request("http://app.local/api/webhooks/whatsapp/bridge/sa_1", {
      method: "POST",
      headers,
      body: rawBody,
    }),
    { params: Promise.resolve({ subAccountId: "sa_1" }) },
  );
}

const NOW = new Date("2026-09-05T12:00:00Z");

const inbound = (over: Record<string, unknown> = {}) => ({
  from: "27821234567@s.whatsapp.net",
  text: "hi there",
  messageId: "3EB0ABC",
  at: "2026-09-05T10:00:00Z",
  ...over,
});

const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const photo = {
  filename: "photo.png",
  mimeType: "image/png",
  dataBase64: PNG_BYTES.toString("base64"),
};

const MIB = 1 << 20;

describe("POST /api/webhooks/whatsapp/bridge/[subAccountId] — media", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    messageWrites = [];
    conversationUpserts = [];
    existingMessageIds = new Set();
    inboundActivities = new Map();
    contactRows = [{ id: "c1", data: { name: "Thabo", phone: "+27821234567" } }];
    subAccountDoc = {
      agencyId: "ag_1",
      whatsappEnabledByAgency: true,
      whatsappProvider: "bridge",
      whatsappBridgeMeta: { displayPhoneNumber: "+27784356159" },
    };
    putWhatsappMedia.mockReset();
    putWhatsappMedia.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores the bytes at whatsappMediaPath and writes `media` on the row", async () => {
    const res = await post(inbound({ media: photo }));
    expect(res.status).toBe(200);

    const path = whatsappMediaPath({
      agencyId: "ag_1",
      subAccountId: "sa_1",
      contactId: "c1",
      messageDocId: "3EB0ABC",
    });
    expect(putWhatsappMedia).toHaveBeenCalledTimes(1);
    const put = putWhatsappMedia.mock.calls[0][0] as {
      path: string;
      bytes: Buffer;
      contentType: string;
    };
    expect(put.path).toBe(path);
    expect(put.contentType).toBe("image/png");
    expect(Buffer.compare(put.bytes, PNG_BYTES)).toBe(0);

    expect(messageWrites).toHaveLength(1);
    expect(messageWrites[0].data.media).toEqual({
      kind: "image",
      mimeType: "image/png",
      filename: "photo.png",
      sizeBytes: PNG_BYTES.length,
      storagePath: path,
    });
    expect(messageWrites[0].data.body).toBe("hi there");
    expect(messageWrites[0].data).not.toHaveProperty("mediaDropped");
  });

  it("passes a bridge-side `mediaDropped` straight through and never touches the bucket", async () => {
    const res = await post(inbound({ mediaDropped: "too_large" }));
    expect(res.status).toBe(200);
    expect(putWhatsappMedia).not.toHaveBeenCalled();
    expect(messageWrites[0].data.mediaDropped).toBe("too_large");
    expect(messageWrites[0].data).not.toHaveProperty("media");
  });

  it("passes through a dropped reason it has never heard of — the bridge names them, not this route", async () => {
    // PR #145 added `delivery_failed`; the next one will add another. An
    // enumeration here would silently swallow every new reason as undefined.
    await post(inbound({ mediaDropped: "delivery_failed" }));
    expect(messageWrites[0].data.mediaDropped).toBe("delivery_failed");
  });

  it("refuses a file that decodes to more than 16 MiB as too_large, bucket untouched", async () => {
    const big = Buffer.alloc(16 * MIB + 1, 0x41).toString("base64");
    const res = await post(
      inbound({ media: { ...photo, dataBase64: big } }),
    );
    expect(res.status).toBe(200);
    expect(putWhatsappMedia).not.toHaveBeenCalled();
    expect(messageWrites[0].data.mediaDropped).toBe("too_large");
    expect(messageWrites[0].data).not.toHaveProperty("media");
    // The message itself is never lost.
    expect(messageWrites[0].data.body).toBe("hi there");
  }, 20_000);

  it("accepts exactly 16 MiB — the cap is inclusive", async () => {
    const exact = Buffer.alloc(16 * MIB, 0x41).toString("base64");
    await post(inbound({ media: { ...photo, dataBase64: exact } }));
    expect(putWhatsappMedia).toHaveBeenCalledTimes(1);
    expect((messageWrites[0].data.media as { sizeBytes: number }).sizeBytes).toBe(16 * MIB);
  }, 20_000);

  it("a 21 MiB base64 body reaches the handler and is refused by OUR cap", async () => {
    // What the bridge will actually POST for a 16 MiB attachment. This proves
    // nothing about the framework (vitest calls the handler directly) — the
    // Next.js body-limit question is settled empirically in the PR body — but
    // it does prove the handler survives the payload size without choking on
    // the decode or the row write.
    const b64 = Buffer.alloc(16 * MIB + 64, 0x41).toString("base64");
    expect(b64.length).toBeGreaterThan(21 * MIB);
    const res = await post(inbound({ media: { ...photo, dataBase64: b64 } }));
    expect(res.status).toBe(200);
    expect(messageWrites[0].data.mediaDropped).toBe("too_large");
  }, 30_000);

  it("BACK-COMPAT: today's text-only payload writes exactly the row origin/main writes", async () => {
    // This is the live Blitz/Velocity rail. The row is compared with toEqual —
    // not toMatchObject — so an added key, even `media: null`, fails here.
    await post(inbound());
    expect(messageWrites).toHaveLength(1);
    expect(messageWrites[0].docId).toBe("3EB0ABC");
    expect(messageWrites[0].data).toEqual({
      agencyId: "ag_1",
      subAccountId: "sa_1",
      contactId: "c1",
      direction: "inbound",
      status: "received",
      body: "hi there",
      from: "+27821234567",
      to: "+27784356159",
      provider: "bridge",
      providerMessageId: "3EB0ABC",
      twilioMessageSid: null,
      sentByUid: null,
      error: null,
      readAt: null,
      createdAt: new Date("2026-09-05T10:00:00Z"),
    });
    expect(Object.keys(messageWrites[0].data)).toEqual([
      "agencyId",
      "subAccountId",
      "contactId",
      "direction",
      "status",
      "body",
      "from",
      "to",
      "provider",
      "providerMessageId",
      "twilioMessageSid",
      "sentByUid",
      "error",
      "readAt",
      "createdAt",
    ]);
    expect(putWhatsappMedia).not.toHaveBeenCalled();
    expect(conversationUpserts[0]).toMatchObject({ body: "hi there" });
    expect(inboundActivities.get("c1/inbound_whatsapp_3EB0ABC")).toMatchObject({
      content: "WhatsApp received: hi there",
    });
  });

  it("a payload carrying media with an invalid HMAC is refused — the signature covers the whole body", async () => {
    const res = await post(inbound({ media: photo }), { secret: "wrong" });
    expect(res.status).toBe(403);
    expect(putWhatsappMedia).not.toHaveBeenCalled();
    expect(messageWrites).toHaveLength(0);
  });

  it("a half-filled media object is a bridge bug: dropped as fetch_failed, never stored unnamed", async () => {
    for (const media of [
      { filename: "x.png", mimeType: "image/png" },
      { filename: "x.png", dataBase64: photo.dataBase64 },
      { mimeType: "image/png", dataBase64: photo.dataBase64 },
      { filename: "", mimeType: "image/png", dataBase64: photo.dataBase64 },
      { filename: "x.png", mimeType: "image/png", dataBase64: "" },
      "not an object",
    ]) {
      messageWrites = [];
      putWhatsappMedia.mockClear();
      const res = await post(inbound({ media }));
      expect(res.status, JSON.stringify(media)).toBe(200);
      expect(putWhatsappMedia, JSON.stringify(media)).not.toHaveBeenCalled();
      expect(messageWrites[0].data.mediaDropped, JSON.stringify(media)).toBe("fetch_failed");
      expect(messageWrites[0].data, JSON.stringify(media)).not.toHaveProperty("media");
    }
  });

  it("refuses a mime the serving route would never put in a Content-Type", async () => {
    await post(inbound({ media: { ...photo, mimeType: "text/html" } }));
    expect(putWhatsappMedia).not.toHaveBeenCalled();
    expect(messageWrites[0].data.mediaDropped).toBe("unsupported_type");
  });

  it("accepts a codec-parameterised voice note and files it as audio", async () => {
    await post(
      inbound({
        text: "",
        media: { filename: "voice.ogg", mimeType: "audio/ogg; codecs=opus", dataBase64: photo.dataBase64 },
      }),
    );
    expect(messageWrites[0].data.media).toMatchObject({
      kind: "audio",
      mimeType: "audio/ogg; codecs=opus",
    });
  });

  it("a caption-less file previews as its kind label, and the row body stays empty", async () => {
    await post(inbound({ text: "", media: photo }));
    expect(messageWrites[0].data.body).toBe("");
    expect(conversationUpserts[0]).toMatchObject({ body: "📷 Photo" });
    expect(inboundActivities.get("c1/inbound_whatsapp_3EB0ABC")).toMatchObject({
      content: "WhatsApp received: 📷 Photo",
    });
  });

  it("a bucket failure degrades to fetch_failed and the row still lands", async () => {
    putWhatsappMedia.mockResolvedValue({ ok: false, reason: "store_failed" });
    const res = await post(inbound({ media: photo }));
    expect(res.status).toBe(200);
    expect(messageWrites[0].data.mediaDropped).toBe("fetch_failed");
    expect(messageWrites[0].data).not.toHaveProperty("media");
    expect(messageWrites[0].data.body).toBe("hi there");
  });

  it("stores one object per matched contact, each at its own contact path", async () => {
    contactRows = [
      { id: "c_a", data: { phone: "+27821234567" } },
      { id: "c_b", data: { phone: "+27821234567" } },
    ];
    await post(inbound({ media: photo }));
    const paths = putWhatsappMedia.mock.calls.map((c) => (c[0] as { path: string }).path).sort();
    expect(paths).toEqual([
      whatsappMediaPath({ agencyId: "ag_1", subAccountId: "sa_1", contactId: "c_a", messageDocId: "3EB0ABC" }),
      whatsappMediaPath({ agencyId: "ag_1", subAccountId: "sa_1", contactId: "c_b", messageDocId: "3EB0ABC" }),
    ]);
    for (const w of messageWrites) {
      expect((w.data.media as { storagePath: string }).storagePath).toBe(
        whatsappMediaPath({ agencyId: "ag_1", subAccountId: "sa_1", contactId: w.contactId, messageDocId: "3EB0ABC" }),
      );
    }
  });

  it("writes the timeline activity on a redelivery too — it is idempotent, so gating it only loses rows", async () => {
    // Delivery 1 wrote the row and died before the activity write. The retry
    // is a redelivery; if the activity is gated behind !isRedelivery the
    // timeline row is lost for good. The Cloud route got this fix in PR #144.
    existingMessageIds.add("3EB0ABC");
    await post(inbound());
    expect(conversationUpserts).toHaveLength(0);
    expect([...inboundActivities.keys()]).toEqual(["c1/inbound_whatsapp_3EB0ABC"]);
  });
});
