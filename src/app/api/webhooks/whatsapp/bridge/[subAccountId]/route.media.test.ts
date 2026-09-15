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

const DELETE_FIELD = "__FIELD_DELETE__";

let contactRows: Array<{ id: string; data: Record<string, unknown> }> = [];
let subAccountDoc: Record<string, unknown> | undefined;
let messageWrites: Array<{ contactId: string; docId: string; data: Record<string, unknown> }> = [];
let conversationUpserts: Array<Record<string, unknown>> = [];
let existingMessageIds = new Set<string>();
/** Set to make the base row `.set()` fail, as a Firestore outage would. */
let rowSetThrows = false;
/** Contact updates committed by the STOP/START batch. */
let optOutUpdates: Array<Record<string, unknown>> = [];
let inboundActivities = new Map<string, Record<string, unknown>>();

function makeSnap(row_: { id: string; data: Record<string, unknown> }) {
  const row_id = row_.id;
  const ref = {
    id: row_id,
    collection: () => ({
      doc: (docId?: string) => ({
        id: docId ?? "generated-id",
        get: async () => ({
          exists: existingMessageIds.has(docId ?? ""),
          data: () => row(row_.id),
        }),
        set: async (data: Record<string, unknown>) => {
          // The base row is the write carrying `direction`; the media merge never does.
          if (rowSetThrows && "direction" in data) throw new Error("firestore unavailable");
          messageWrites.push({ contactId: row_id, docId: docId ?? "", data });
          // A stored row is what the next delivery's redelivery check reads.
          existingMessageIds.add(docId ?? "");
        },
      }),
    }),
  };
  return { id: row_id, data: () => row_.data, ref };
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
    const pending: Array<Record<string, unknown>> = [];
    return {
      update: (_ref: unknown, data: Record<string, unknown>) => {
        pending.push(data);
      },
      set: () => {},
      commit: async () => {
        optOutUpdates.push(...pending);
      },
    };
  },
};

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => fakeDb }));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "SERVER_TS", delete: () => DELETE_FIELD },
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
let aiOn = false;
const maybeRespondWithAi = vi.fn();
vi.mock("@/lib/comms/ai/openrouter", () => ({ aiIsConfigured: () => aiOn }));
vi.mock("@/lib/comms/ai/agent", () => ({
  resolveAgent: async () => (aiOn ? { effective: { enabled: true } } : null),
}));
vi.mock("@/lib/comms/ai/respond", () => ({
  maybeRespondWithAi: (...a: unknown[]) => maybeRespondWithAi(...a),
}));

/** The bucket. Only `putWhatsappMedia` is faked — `whatsappMediaPath` is the
 *  real one, so the test asserts the path the serving route will re-derive. */
const putWhatsappMedia = vi.fn();
vi.mock("@/lib/comms/whatsapp/media-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/comms/whatsapp/media-storage")>()),
  putWhatsappMedia: (...a: unknown[]) => putWhatsappMedia(...a),
}));

import { POST } from "./route";

/** The row as Firestore would hold it after every `{merge:true}` write. */
function row(contactId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const w of messageWrites.filter((x) => x.contactId === contactId)) {
    for (const [k, v] of Object.entries(w.data)) {
      if (v === DELETE_FIELD) delete out[k];
      else out[k] = v;
    }
  }
  return out;
}

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
    aiOn = false;
    maybeRespondWithAi.mockReset();
    rowSetThrows = false;
    optOutUpdates = [];
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

    expect(row("c1").media).toEqual({
      kind: "image",
      mimeType: "image/png",
      filename: "photo.png",
      sizeBytes: PNG_BYTES.length,
      storagePath: path,
    });
    expect(row("c1").body).toBe("hi there");
    expect(row("c1")).not.toHaveProperty("mediaDropped");
  });

  it("passes a bridge-side `mediaDropped` straight through and never touches the bucket", async () => {
    const res = await post(inbound({ mediaDropped: "too_large" }));
    expect(res.status).toBe(200);
    expect(putWhatsappMedia).not.toHaveBeenCalled();
    expect(row("c1").mediaDropped).toBe("too_large");
    expect(row("c1")).not.toHaveProperty("media");
  });

  it("passes through a dropped reason it has never heard of — the bridge names them, not this route", async () => {
    // PR #145 added `delivery_failed`; the next one will add another. An
    // enumeration here would silently swallow every new reason as undefined.
    await post(inbound({ mediaDropped: "delivery_failed" }));
    expect(row("c1").mediaDropped).toBe("delivery_failed");
  });

  it("refuses a file that decodes to more than 16 MiB as too_large, bucket untouched", async () => {
    const big = Buffer.alloc(16 * MIB + 1, 0x41).toString("base64");
    const res = await post(
      inbound({ media: { ...photo, dataBase64: big } }),
    );
    expect(res.status).toBe(200);
    expect(putWhatsappMedia).not.toHaveBeenCalled();
    expect(row("c1").mediaDropped).toBe("too_large");
    expect(row("c1")).not.toHaveProperty("media");
    // The message itself is never lost.
    expect(row("c1").body).toBe("hi there");
  }, 20_000);

  it("accepts exactly 16 MiB — the cap is inclusive", async () => {
    const exact = Buffer.alloc(16 * MIB, 0x41).toString("base64");
    await post(inbound({ media: { ...photo, dataBase64: exact } }));
    expect(putWhatsappMedia).toHaveBeenCalledTimes(1);
    expect((row("c1").media as { sizeBytes: number }).sizeBytes).toBe(16 * MIB);
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
    expect(row("c1").mediaDropped).toBe("too_large");
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
      expect(row("c1").mediaDropped, JSON.stringify(media)).toBe("fetch_failed");
      expect(row("c1"), JSON.stringify(media)).not.toHaveProperty("media");
    }
  });

  it("refuses a mime the serving route would never put in a Content-Type", async () => {
    await post(inbound({ media: { ...photo, mimeType: "text/html" } }));
    expect(putWhatsappMedia).not.toHaveBeenCalled();
    expect(row("c1").mediaDropped).toBe("unsupported_type");
  });

  it("accepts a codec-parameterised voice note and files it as audio", async () => {
    await post(
      inbound({
        text: "",
        media: { filename: "voice.ogg", mimeType: "audio/ogg; codecs=opus", dataBase64: photo.dataBase64 },
      }),
    );
    expect(row("c1").media).toMatchObject({
      kind: "audio",
      mimeType: "audio/ogg; codecs=opus",
    });
  });

  it("a caption-less file previews as its kind label, and the row body stays empty", async () => {
    await post(inbound({ text: "", media: photo }));
    expect(row("c1").body).toBe("");
    expect(conversationUpserts[0]).toMatchObject({ body: "📷 Photo" });
    expect(inboundActivities.get("c1/inbound_whatsapp_3EB0ABC")).toMatchObject({
      content: "WhatsApp received: 📷 Photo",
    });
  });

  it("a bucket failure degrades to fetch_failed and the row still lands", async () => {
    putWhatsappMedia.mockResolvedValue({ ok: false, reason: "store_failed" });
    const res = await post(inbound({ media: photo }));
    expect(res.status).toBe(200);
    expect(row("c1").mediaDropped).toBe("fetch_failed");
    expect(row("c1")).not.toHaveProperty("media");
    expect(row("c1").body).toBe("hi there");
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
    for (const contactId of ["c_a", "c_b"]) {
      expect((row(contactId).media as { storagePath: string }).storagePath).toBe(
        whatsappMediaPath({ agencyId: "ag_1", subAccountId: "sa_1", contactId, messageDocId: "3EB0ABC" }),
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
  it("a storage exception never costs the message text — the row lands with fetch_failed", async () => {
    putWhatsappMedia.mockRejectedValue(new Error("bucket exploded"));
    const res = await post(inbound({ media: photo }));
    expect(res.status).toBe(200);
    expect(row("c1").body).toBe("hi there");
    expect(row("c1").mediaDropped).toBe("fetch_failed");
    expect(row("c1")).not.toHaveProperty("media");
  });

  it("writes the text row BEFORE the upload, so a re-post during a slow upload is a redelivery", async () => {
    // #145 re-posts the same message id text-only with mediaDropped when a
    // media POST goes unanswered, and Next does not abort the first handler.
    // With the upload ahead of the row write, B found no row, passed the
    // redelivery check, and both requests auto-replied to the customer.
    aiOn = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    putWhatsappMedia.mockImplementation(async () => {
      await gate;
      return { ok: true };
    });

    const a = post(inbound({ media: photo }));
    // Let A run up to the blocked upload.
    await vi.waitFor(() => expect(putWhatsappMedia).toHaveBeenCalledTimes(1));

    const b = await post(inbound({ mediaDropped: "delivery_failed" }));
    expect(b.status).toBe(200);

    release();
    expect((await a).status).toBe(200);

    expect(maybeRespondWithAi).toHaveBeenCalledTimes(1);
    expect(conversationUpserts).toHaveLength(1);
  });
  it("a text-only delivery_failed re-post never downgrades a row that already holds its file", async () => {
    // #145 re-posts text-only when a media POST goes unanswered — but that POST
    // may have landed. The re-post must not add a drop reason beside the file
    // or rewrite the timeline from "📷 Photo" to "(no text)".
    await post(inbound({ text: "", media: photo }));
    expect(row("c1").media).toBeTruthy();

    await post(inbound({ text: "", mediaDropped: "delivery_failed" }));
    expect(row("c1").media).toMatchObject({ kind: "image", filename: "photo.png" });
    expect(row("c1")).not.toHaveProperty("mediaDropped");
    expect(inboundActivities.get("c1/inbound_whatsapp_3EB0ABC")).toMatchObject({
      content: "WhatsApp received: 📷 Photo",
    });
  });

  it("the reverse order upgrades: a text-only drop first, then the file, leaves only the file", async () => {
    await post(inbound({ text: "", mediaDropped: "delivery_failed" }));
    expect(row("c1").mediaDropped).toBe("delivery_failed");

    await post(inbound({ text: "", media: photo }));
    expect(row("c1").media).toMatchObject({ kind: "image" });
    expect(row("c1")).not.toHaveProperty("mediaDropped");
    expect(inboundActivities.get("c1/inbound_whatsapp_3EB0ABC")).toMatchObject({
      content: "WhatsApp received: 📷 Photo",
    });
  });

  it("rejects base64 that Node would silently mis-decode", async () => {
    // Node skips characters outside the alphabet and stops at the first "=",
    // so each of these decoded to SOMETHING — "!!!!" to a 0-byte image.
    for (const dataBase64 of ["!!!!", "aGVsbG8=GARBAGE", "aGVs-G8_", "aGVsbG8", "aGVs bG8="]) {
      messageWrites = [];
      existingMessageIds = new Set();
      putWhatsappMedia.mockClear();
      await post(inbound({ media: { ...photo, dataBase64 } }));
      expect(putWhatsappMedia, dataBase64).not.toHaveBeenCalled();
      expect(row("c1").mediaDropped, dataBase64).toBe("fetch_failed");
      expect(row("c1"), dataBase64).not.toHaveProperty("media");
    }
  });

  it("accepts every padding form of valid base64", async () => {
    for (const [dataBase64, size] of [["aGVsbG8=", 5], ["aGVsbA==", 4], ["aGVs", 3]] as const) {
      messageWrites = [];
      existingMessageIds = new Set();
      await post(inbound({ media: { ...photo, dataBase64 } }));
      expect((row("c1").media as { sizeBytes: number }).sizeBytes, dataBase64).toBe(size);
    }
  });

  it("caps a huge filename at 255 bytes, keeping the extension, on the row and in the preview", async () => {
    const name = `${"a".repeat(10_000)}.pdf`;
    await post(
      inbound({ text: "", media: { filename: name, mimeType: "application/pdf", dataBase64: photo.dataBase64 } }),
    );
    const stored = (row("c1").media as { filename: string }).filename;
    expect(Buffer.byteLength(stored, "utf8")).toBeLessThanOrEqual(255);
    expect(stored.endsWith(".pdf")).toBe(true);
    expect(conversationUpserts[0]).toMatchObject({ body: `📄 ${stored}` });
  });

  it("cuts a multi-byte filename on a character boundary, never mid-character", async () => {
    // 251 bytes of budget before ".pdf" / ".jpg": odd for 2-byte "é", and not
    // a multiple of 4 for the emoji — a byte slice would split both.
    for (const [name, mimeType] of [
      [`${"é".repeat(200)}.pdf`, "application/pdf"],
      [`${"😀".repeat(100)}.jpg`, "image/jpeg"],
    ] as const) {
      messageWrites = [];
      existingMessageIds = new Set();
      await post(inbound({ media: { filename: name, mimeType, dataBase64: photo.dataBase64 } }));
      const stored = (row("c1").media as { filename: string }).filename;
      expect(Buffer.byteLength(stored, "utf8"), name).toBeLessThanOrEqual(255);
      expect(stored, name).not.toContain("\uFFFD");
      expect(Buffer.from(stored, "utf8").toString("utf8"), name).toBe(stored);
      expect(stored.endsWith(name.slice(-4)), name).toBe(true);
    }
  });

  it("ignores a mediaDropped that is not a string — the text path, unmarked", async () => {
    for (const mediaDropped of [42, { reason: "x" }, true, ["too_large"]]) {
      messageWrites = [];
      existingMessageIds = new Set();
      const res = await post(inbound({ mediaDropped }));
      expect(res.status).toBe(200);
      expect(messageWrites, JSON.stringify(mediaDropped)).toHaveLength(1);
      expect(row("c1"), JSON.stringify(mediaDropped)).not.toHaveProperty("mediaDropped");
      expect(row("c1").body).toBe("hi there");
    }
  });

  it("files video and document mimes under their own kinds", async () => {
    for (const [mimeType, kind] of [
      ["video/mp4", "video"],
      ["application/pdf", "document"],
    ] as const) {
      messageWrites = [];
      existingMessageIds = new Set();
      await post(inbound({ media: { ...photo, mimeType } }));
      expect(row("c1").media, mimeType).toMatchObject({ kind, mimeType });
    }
  });
  it("indexes the conversation and auto-replies BEFORE the upload, so a stalled upload strands nothing", async () => {
    // A deploy restart or a hung save() kills the first handler mid-upload.
    // The bridge re-posts text-only; the row exists, so that re-post is a
    // redelivery and skips the upsert and the AI. If the first handler had not
    // done them before uploading, nobody would — the message would never reach
    // the unified inbox.
    aiOn = true;
    putWhatsappMedia.mockImplementation(() => new Promise(() => {}));

    void post(inbound({ media: photo }));
    await vi.waitFor(() => expect(putWhatsappMedia).toHaveBeenCalledTimes(1));

    const retry = await post(inbound({ mediaDropped: "delivery_failed" }));
    expect(retry.status).toBe(200);

    expect(conversationUpserts).toHaveLength(1);
    expect(maybeRespondWithAi).toHaveBeenCalledTimes(1);
    expect(inboundActivities.get("c1/inbound_whatsapp_3EB0ABC")).toMatchObject({
      content: "WhatsApp received: hi there",
    });
  });

  it("never auto-replies to a caption-less file, but does to a captioned one", async () => {
    // A caption-less photo has an empty body. Handing it to the AI sends a
    // real WhatsApp reply to a customer about nothing.
    aiOn = true;
    await post(inbound({ text: "  ", media: photo, messageId: "3EB0BARE" }));
    expect(maybeRespondWithAi).not.toHaveBeenCalled();

    await post(inbound({ text: "is this the right router?", media: photo, messageId: "3EB0CAPT" }));
    expect(maybeRespondWithAi).toHaveBeenCalledTimes(1);
    expect(maybeRespondWithAi.mock.calls[0][0]).toMatchObject({
      incomingMessage: "is this the right router?",
    });
  });

  it("does not merge media onto a row whose write failed — no partial doc", async () => {
    // {media, mediaDropped:<delete>} alone would create a doc with no body,
    // direction or createdAt, which every later delivery reads as "seen".
    rowSetThrows = true;
    const res = await post(inbound({ media: photo }));
    expect(res.status).toBe(200);
    expect(messageWrites).toHaveLength(0);
    expect(putWhatsappMedia).not.toHaveBeenCalled();
  });

  it("drops an over-long 'extension' rather than letting it blow the 255-byte cap", async () => {
    const name = `a.${"b".repeat(300)}`;
    await post(
      inbound({ media: { filename: name, mimeType: "application/pdf", dataBase64: photo.dataBase64 } }),
    );
    const stored = (row("c1").media as { filename: string }).filename;
    expect(Buffer.byteLength(stored, "utf8")).toBeLessThanOrEqual(255);
    expect(stored.length).toBeGreaterThan(0);
  });

  it("treats `media: null` as no media — one write, no drop reason", async () => {
    const res = await post(inbound({ media: null }));
    expect(res.status).toBe(200);
    expect(messageWrites).toHaveLength(1);
    expect(row("c1")).not.toHaveProperty("mediaDropped");
    expect(putWhatsappMedia).not.toHaveBeenCalled();
  });

  it("a STOP sent as a photo caption records the opt-out AND keeps the photo", async () => {
    aiOn = true;
    const res = await post(inbound({ text: "STOP", media: photo }));
    expect(await res.json()).toMatchObject({ persisted: true, optedOut: true });
    expect(optOutUpdates).toEqual([expect.objectContaining({ whatsappOptedOut: true })]);
    expect(row("c1").media).toMatchObject({ kind: "image" });
    expect(maybeRespondWithAi).not.toHaveBeenCalled();
  });
  it("never stores the outbound-only `store_failed` reason on an inbound row", async () => {
    // Its label reads "Sent — no copy kept here", which is untrue for a message the customer sent us.
    await post(inbound({ mediaDropped: "store_failed" }));
    expect(row("c1").mediaDropped).toBe("fetch_failed");
  });
  it("never auto-replies to a START either — an opt-in is not a conversation", async () => {
    aiOn = true;
    const res = await post(inbound({ text: "START" }));
    expect(await res.json()).toMatchObject({ optedOut: false });
    expect(optOutUpdates).toEqual([expect.objectContaining({ whatsappOptedOut: false })]);
    expect(maybeRespondWithAi).not.toHaveBeenCalled();
  });
});
