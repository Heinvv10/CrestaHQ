import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { whatsappMediaPath } from "@/lib/comms/whatsapp/media-storage";

/**
 * Outbound media through the WHOLE seam: route → conversation send →
 * dispatcher → cloud client → Graph (fetch mocked) → Storage (bucket mocked).
 *
 * The dispatcher and the cloud client are real. The sibling `route.test.ts`
 * mocks the dispatcher, which is right for what it tests (refusal wording)
 * and useless here: the thing under test is whether a file attached on a
 * Cloud sub-account is uploaded, referenced by id in the message, and then
 * stored against the row — or refused before any of that on a rail that
 * cannot carry it.
 */

const requireUid = vi.fn();
const requireContactAccessible = vi.fn();
const checkWhatsappReadiness = vi.fn();
const getChannelConfig = vi.fn();
const getWabaCreds = vi.fn();
const getBridgeCreds = vi.fn();
const sendWhatsappBridge = vi.fn();
const upsertConversationForMessage = vi.fn();
let fetchMock: ReturnType<typeof vi.fn>;

let subAccountDoc: Record<string, unknown> | undefined;
let messageRow: Record<string, unknown> | undefined;
let messageRowId: string | undefined;
/** What the bucket received: path → bytes + contentType. */
let saved: Array<{ path: string; bytes: Buffer; contentType: string }>;
let saveThrows: Error | null;
/** getStorage itself throws, synchronously, before any file handle exists. */
let getStorageThrows: Error | null;

vi.mock("@/lib/comms/route-auth", () => ({
  requireUid: (...a: unknown[]) => requireUid(...a),
  requireContactAccessible: (...a: unknown[]) => requireContactAccessible(...a),
}));
vi.mock("@/lib/comms/whatsapp/readiness", () => ({
  checkWhatsappReadiness: (...a: unknown[]) => checkWhatsappReadiness(...a),
}));
vi.mock("@/lib/comms/ai/agent", () => ({
  getChannelConfig: (...a: unknown[]) => getChannelConfig(...a),
}));
vi.mock("@/lib/comms/whatsapp/cloud-credentials", () => ({
  getWabaCreds: (...a: unknown[]) => getWabaCreds(...a),
}));
vi.mock("@/lib/comms/whatsapp/bridge-credentials", () => ({
  getBridgeCreds: (...a: unknown[]) => getBridgeCreds(...a),
}));
vi.mock("@/lib/comms/whatsapp/bridge-client", () => ({
  sendWhatsappBridge: (...a: unknown[]) => sendWhatsappBridge(...a),
}));
vi.mock("@/lib/comms/twilio", () => ({
  sendWhatsappForSubAccount: vi.fn(),
}));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: (...a: unknown[]) =>
    upsertConversationForMessage(...a),
}));
vi.mock("@/lib/reviews/review-ask", () => ({
  askOutcomeOf: () => "not_a_review_ask",
  logInboxReviewAsk: async () => undefined,
}));
vi.mock("firebase-admin/storage", () => ({
  getStorage: () => {
    if (getStorageThrows) throw getStorageThrows;
    return {
      bucket: () => ({
        file: (path: string) => ({
          save: async (bytes: Buffer, opts: { metadata: { contentType: string } }) => {
            if (saveThrows) throw saveThrows;
            saved.push({ path, bytes, contentType: opts.metadata.contentType });
          },
        }),
      }),
    };
  },
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminApp: () => ({ name: "test-app" }),
  getAdminDb: () => ({
    doc: () => ({
      get: async () => ({
        exists: subAccountDoc !== undefined,
        data: () => subAccountDoc,
      }),
    }),
    collection: (name: string) => {
      if (name === "contacts") {
        return {
          doc: () => ({
            collection: (sub: string) => ({
              add: async () => undefined,
              doc: (id: string) => ({
                set: async (data: Record<string, unknown>) => {
                  if (sub === "whatsappMessages") {
                    messageRow = data;
                    messageRowId = id;
                  }
                },
              }),
            }),
          }),
        };
      }
      // `readLastInboundAt` — one inbound an hour ago, so the window is open.
      return {
        orderBy: () => ({
          limit: () => ({
            get: async () => ({
              docs: [
                {
                  data: () => ({
                    direction: "inbound",
                    createdAt: { toDate: () => new Date(Date.now() - 3600_000) },
                  }),
                },
              ],
            }),
          }),
        }),
      };
    },
  }),
}));

import { POST } from "./route";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const attachment = {
  filename: "site-photo.png",
  contentType: "image/png",
  dataBase64: PNG_BYTES.toString("base64"),
};
const creds = { phoneNumberId: "PN1", wabaId: "WA1", accessToken: "EAAG" };

function post(body: unknown) {
  return POST(
    new Request("https://crm.test/api/comms/whatsapp/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );
}

function graphOk(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

/** The Graph calls made, in order, by path suffix. */
function graphCalls(): Array<{ url: string; init: RequestInit }> {
  return fetchMock.mock.calls.map((c) => ({ url: c[0] as string, init: c[1] as RequestInit }));
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET", "test-bucket");
  messageRow = undefined;
  messageRowId = undefined;
  saved = [];
  saveThrows = null;
  getStorageThrows = null;
  subAccountDoc = { whatsappEnabledByAgency: true, whatsappProvider: "cloud" };
  requireUid.mockReturnValue({ uid: "u1" });
  requireContactAccessible.mockResolvedValue({
    id: "c1",
    agencyId: "ag1",
    subAccountId: "sa1",
    phone: "+27821234567",
    whatsappOptedOut: false,
  });
  checkWhatsappReadiness.mockResolvedValue({ ready: true, provider: "cloud" });
  getChannelConfig.mockResolvedValue(null);
  getWabaCreds.mockResolvedValue(creds);
  upsertConversationForMessage.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("POST /api/comms/whatsapp/send — media on the Cloud rail", () => {
  it("uploads the file, sends it by media id with the text as caption, then stores a copy on the row", async () => {
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "MEDIA1" }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.OUT1" }] }));

    const res = await post({ contactId: "c1", body: "here is the site", attachment });
    expect(res.status).toBe(200);

    const [upload, send] = graphCalls();
    // 1. POST /{phone_number_id}/media, multipart, bearer-authorised.
    expect(upload!.url).toMatch(/\/PN1\/media$/);
    expect(upload!.init.method).toBe("POST");
    expect((upload!.init.headers as Record<string, string>).Authorization).toBe("Bearer EAAG");
    const form = upload!.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("messaging_product")).toBe("whatsapp");
    const file = form.get("file") as File;
    expect(file.name).toBe("site-photo.png");
    expect(file.type).toBe("image/png");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(PNG_BYTES);

    // 2. The message references the id; the text rides as the caption.
    expect(send!.url).toMatch(/\/PN1\/messages$/);
    const body = JSON.parse(send!.init.body as string);
    expect(body).toMatchObject({
      messaging_product: "whatsapp",
      to: "27821234567",
      type: "image",
      image: { id: "MEDIA1", caption: "here is the site" },
    });
    expect(body.text).toBeUndefined();

    // 3. The row carries `media`, pointing at bytes the bucket actually has.
    expect(messageRowId).toBe("wamid.OUT1");
    const expectedPath = whatsappMediaPath({
      agencyId: "ag1",
      subAccountId: "sa1",
      contactId: "c1",
      messageDocId: "wamid.OUT1",
    });
    expect(messageRow?.media).toEqual({
      kind: "image",
      mimeType: "image/png",
      filename: "site-photo.png",
      sizeBytes: PNG_BYTES.length,
      storagePath: expectedPath,
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ path: expectedPath, contentType: "image/png" });
    expect(saved[0]!.bytes).toEqual(PNG_BYTES);
    // §0.1: `media` is the one field. No second description of the same file.
    expect(messageRow).not.toHaveProperty("attachment");
    expect(JSON.stringify(messageRow)).not.toContain(attachment.dataBase64);
  });

  it("sends a PDF as a document carrying its filename", async () => {
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "MEDIA2" }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.OUT2" }] }));

    const res = await post({
      contactId: "c1",
      body: "your quote",
      attachment: { ...attachment, filename: "quote.pdf", contentType: "application/pdf" },
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(graphCalls()[1]!.init.body as string);
    expect(body).toMatchObject({
      type: "document",
      document: { id: "MEDIA2", caption: "your quote", filename: "quote.pdf" },
    });
    expect(messageRow?.media).toMatchObject({ kind: "document", filename: "quote.pdf" });
  });

  it("answers 400 with the provider code when Meta rejects the upload, and stores nothing", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => '{"error":{"message":"(#100) Unsupported file"}}',
      json: async () => ({}),
    });

    const res = await post({ contactId: "c1", body: "here", attachment });
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe("media_upload_failed");
    // The upload strictly precedes the send: nothing reached the customer,
    // so nothing may appear in the thread as if it had.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(saved).toHaveLength(0);
    expect(messageRow).toBeUndefined();
    expect(upsertConversationForMessage).not.toHaveBeenCalled();
  });

  it("does not store the copy when the send itself fails after a good upload", async () => {
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "MEDIA3" }))
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => "bad recipient", json: async () => ({}) });

    const res = await post({ contactId: "c1", body: "here", attachment });
    expect(res.ok).toBe(false);
    expect(saved).toHaveLength(0);
    expect(messageRow).toBeUndefined();
  });

  it("refuses a 6 MB image before any Graph call — Meta's image cap is 5 MB", async () => {
    // A picker that admits the file and a Graph call that then refuses it is
    // a wasted upload and an operator left guessing; the cap is per kind.
    const sixMb = Buffer.alloc(6 * 1024 * 1024, 1);
    const res = await post({
      contactId: "c1",
      body: "here",
      attachment: { ...attachment, dataBase64: sixMb.toString("base64") },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("media_too_large");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it("accepts a 6 MB PDF — documents are capped at 16 MiB, not the image cap", async () => {
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "MEDIA6" }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.OUT6" }] }));
    const sixMb = Buffer.alloc(6 * 1024 * 1024, 1);
    const res = await post({
      contactId: "c1",
      body: "here",
      attachment: { filename: "big.pdf", contentType: "application/pdf", dataBase64: sixMb.toString("base64") },
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(messageRow?.media).toMatchObject({ kind: "document", sizeBytes: sixMb.length });
  });

  it("refuses an image between 5,000,000 and 5 MiB bytes — Meta's 5 MB is decimal", async () => {
    const justOver = Buffer.alloc(5_100_000, 1);
    const res = await post({
      contactId: "c1",
      body: "here",
      attachment: { ...attachment, dataBase64: justOver.toString("base64") },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("media_too_large");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a caption over Meta's 1024 characters before any Graph call", async () => {
    // Uploading first and letting the message POST fail wastes the upload and
    // hands the operator a 502 carrying raw Graph JSON.
    const res = await post({
      contactId: "c1",
      body: "x".repeat(1025),
      attachment: { ...attachment, filename: "q.pdf", contentType: "application/pdf" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("caption_too_long");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it("sends a caption of exactly 1024 characters", async () => {
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "MEDIA7" }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.OUT7" }] }));
    const res = await post({
      contactId: "c1",
      body: "x".repeat(1024),
      attachment: { ...attachment, filename: "q.pdf", contentType: "application/pdf" },
    });
    expect(res.status).toBe(200);
  });

  it("refuses video/mp4 on Cloud until a live proof", async () => {
    const res = await post({
      contactId: "c1",
      body: "here",
      attachment: { filename: "clip.mp4", contentType: "video/mp4", dataBase64: "AAEC" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("media_unsupported_type");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a file over 16 MiB on every kind", async () => {
    const big = Buffer.alloc(16 * 1024 * 1024 + 1, 1);
    const res = await post({
      contactId: "c1",
      body: "here",
      attachment: { filename: "big.pdf", contentType: "application/pdf", dataBase64: big.toString("base64") },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("media_too_large");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a type the Cloud rail does not declare, before any Graph call", async () => {
    const res = await post({
      contactId: "c1",
      body: "here",
      attachment: { ...attachment, filename: "x.svg", contentType: "image/svg+xml" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("media_unsupported_type");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/comms/whatsapp/send — media on the other rails", () => {
  it("still refuses an attachment on Twilio with 400, touching neither Graph nor Storage", async () => {
    subAccountDoc = { whatsappEnabledByAgency: true, whatsappProvider: "twilio" };
    checkWhatsappReadiness.mockResolvedValue({ ready: true, provider: "twilio" });

    const res = await post({ contactId: "c1", body: "here", attachment });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getWabaCreds).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
    expect(messageRow).toBeUndefined();
  });

  it("hands the bridge its media unchanged and writes `media` on the row, not `attachment`", async () => {
    subAccountDoc = { whatsappEnabledByAgency: true, whatsappProvider: "bridge" };
    checkWhatsappReadiness.mockResolvedValue({ ready: true, provider: "bridge" });
    getBridgeCreds.mockResolvedValue({ baseUrl: "http://b:1", token: "t", webhookSecret: "w" });
    sendWhatsappBridge.mockResolvedValue({ ok: true, messageId: "3EB0" });

    const res = await post({ contactId: "c1", body: "here", attachment });
    expect(res.status).toBe(200);
    expect(sendWhatsappBridge).toHaveBeenCalledWith(expect.objectContaining({ media: attachment }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(messageRow?.media).toMatchObject({
      kind: "image",
      filename: "site-photo.png",
      storagePath: whatsappMediaPath({
        agencyId: "ag1",
        subAccountId: "sa1",
        contactId: "c1",
        messageDocId: "3EB0",
      }),
    });
    expect(messageRow).not.toHaveProperty("attachment");
    expect(saved).toHaveLength(1);
  });

  it("marks the row store_failed — never fetch_failed — when the send succeeded but the copy failed", async () => {
    subAccountDoc = { whatsappEnabledByAgency: true, whatsappProvider: "bridge" };
    checkWhatsappReadiness.mockResolvedValue({ ready: true, provider: "bridge" });
    getBridgeCreds.mockResolvedValue({ baseUrl: "http://b:1", token: "t", webhookSecret: "w" });
    sendWhatsappBridge.mockResolvedValue({ ok: true, messageId: "3EB1" });
    saveThrows = new Error("bucket down");

    const res = await post({ contactId: "c1", body: "here", attachment });
    // The customer got the file. The row must still say a file went, and
    // must not read "download failed" — an operator would resend it.
    expect(res.status).toBe(200);
    expect(messageRow?.media).toBeUndefined();
    expect(messageRow?.mediaDropped).toBe("store_failed");
  });

  it("still writes the row (store_failed) and answers 200 when resolving the bucket throws", async () => {
    subAccountDoc = { whatsappEnabledByAgency: true, whatsappProvider: "bridge" };
    checkWhatsappReadiness.mockResolvedValue({ ready: true, provider: "bridge" });
    getBridgeCreds.mockResolvedValue({ baseUrl: "http://b:1", token: "t", webhookSecret: "w" });
    sendWhatsappBridge.mockResolvedValue({ ok: true, messageId: "3EB2" });
    getStorageThrows = new Error("The default Firebase app does not exist");

    const res = await post({ contactId: "c1", body: "here", attachment });
    expect(res.status).toBe(200);
    expect(messageRowId).toBe("3EB2");
    expect(messageRow?.mediaDropped).toBe("store_failed");
  });

  it("writes neither media field on a plain text row", async () => {
    fetchMock.mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.T" }] }));
    const res = await post({ contactId: "c1", body: "just text" });
    expect(res.status).toBe(200);
    expect(messageRow).not.toHaveProperty("media");
    expect(messageRow).not.toHaveProperty("mediaDropped");
    expect(messageRow).not.toHaveProperty("attachment");
    expect(saved).toHaveLength(0);
  });
});
