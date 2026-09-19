import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { whatsappMediaPath } from "@/lib/comms/whatsapp/media-storage";
import { bucketFake, resetBucketFake, stageObject } from "@/test/staged-bucket";

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
vi.mock("firebase-admin/storage", async () => (await import("@/test/staged-bucket")).storageMock());
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
/** A file as the composer would have uploaded it; `post` stages it first. */
const attachment = {
  filename: "site-photo.png",
  contentType: "image/png",
  bytes: PNG_BYTES,
};
const creds = { phoneNumberId: "PN1", wabaId: "WA1", accessToken: "EAAG" };
/** Real files from __fixtures__/video — see generate.sh there. */
function mp4(name: string) {
  return {
    filename: "clip.mp4",
    contentType: "video/mp4",
    bytes: readFileSync(
      join(__dirname, "../../../../../lib/comms/whatsapp/__fixtures__/video", name),
    ),
  };
}
const h264 = mp4("h264-aac-faststart.mp4");
const hevc = mp4("hevc-hvc1-aac.mp4");

const STAGED_ID = "AbCdEfGhIjKlMnOpQrStUv_-";
const STAGED_PATH = `whatsapp-staging/ag1/sa1/u1/${STAGED_ID}`;

/** Stages `attachment.bytes` where the composer's upload would have put it, then sends by id. */
function post(body: { attachment?: { filename: string; contentType: string; bytes: Buffer } } & Record<string, unknown>) {
  const { attachment: file, ...rest } = body;
  if (file) stageObject(STAGED_PATH, file.bytes, file.contentType);
  return POST(
    new Request("https://crm.test/api/comms/whatsapp/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...rest,
        ...(file ? { attachment: { stagedId: STAGED_ID, filename: file.filename, contentType: file.contentType } } : {}),
      }),
    }) as never,
  );
}

/** Thread copies made, as Storage copies out of the staging object. */
function copies() {
  return bucketFake.log.filter((l) => l.startsWith("copy "));
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
  resetBucketFake();
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
    expect(copies()).toEqual([`copy ${STAGED_PATH}@7 -> ${expectedPath}`]);
    expect(bucketFake.objects.get(expectedPath)).toMatchObject({ bytes: PNG_BYTES, contentType: "image/png" });
    // §0.1: `media` is the one field. No second description of the same file.
    expect(messageRow).not.toHaveProperty("attachment");
    expect(JSON.stringify(messageRow)).not.toContain(PNG_BYTES.toString("base64"));
  });

  it("sends a file with no text: 200, no caption on the wire, the label as the inbox preview", async () => {
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "MEDIA0" }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.OUT0" }] }));

    const res = await post({ contactId: "c1", body: "", attachment });
    expect(res.status).toBe(200);

    const body = JSON.parse(graphCalls()[1]!.init.body as string);
    expect(body).toMatchObject({ type: "image", image: { id: "MEDIA0" } });
    expect(body.image).not.toHaveProperty("caption");
    // The thread row keeps the empty body and renders the file alone; the
    // inbox list gets the same label a caption-less inbound photo does.
    expect(messageRow?.body).toBe("");
    expect(messageRow?.media).toMatchObject({ kind: "image", filename: "site-photo.png" });
    expect(upsertConversationForMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: "📷 Photo" }),
    );
  });

  it("accepts an attachment with no body field at all", async () => {
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "MEDIA0B" }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.OUT0B" }] }));
    const res = await post({ contactId: "c1", attachment });
    expect(res.status).toBe(200);
  });

  it.each([
    ["an empty body", { contactId: "c1", body: "" }],
    ["a whitespace body", { contactId: "c1", body: "   " }],
    ["no body", { contactId: "c1" }],
  ])("still refuses %s with no attachment, before any send", async (_label, payload) => {
    const res = await post(payload);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(requireContactAccessible).not.toHaveBeenCalled();
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
    expect(copies()).toHaveLength(0);
    expect(messageRow).toBeUndefined();
    expect(upsertConversationForMessage).not.toHaveBeenCalled();
  });

  it("does not store the copy when the send itself fails after a good upload", async () => {
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "MEDIA3" }))
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => "bad recipient", json: async () => ({}) });

    const res = await post({ contactId: "c1", body: "here", attachment });
    expect(res.ok).toBe(false);
    expect(copies()).toHaveLength(0);
    expect(messageRow).toBeUndefined();
  });

  it("refuses a 6 MB image before any Graph call — Meta's image cap is 5 MB", async () => {
    // A picker that admits the file and a Graph call that then refuses it is
    // a wasted upload and an operator left guessing; the cap is per kind.
    const sixMb = Buffer.alloc(6 * 1024 * 1024, 1);
    const res = await post({
      contactId: "c1",
      body: "here",
      attachment: { ...attachment, bytes: sixMb },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("media_too_large");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(copies()).toHaveLength(0);
  });

  it("accepts a 6 MB PDF — documents are not held to the image cap", async () => {
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "MEDIA6" }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.OUT6" }] }));
    const sixMb = Buffer.alloc(6 * 1024 * 1024, 1);
    const res = await post({
      contactId: "c1",
      body: "here",
      attachment: { filename: "big.pdf", contentType: "application/pdf", bytes: sixMb },
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
      attachment: { ...attachment, bytes: justOver },
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
    expect(copies()).toHaveLength(0);
  });

  it("refuses a filename over 255 UTF-8 bytes at the route, before any Graph call", async () => {
    // The row and the activity store the name verbatim, and are written only
    // after the send; an unbounded name could fail those writes with the
    // customer already holding the file. Same bound the bridge enforces.
    const res = await post({
      contactId: "c1",
      body: "here",
      attachment: { ...attachment, filename: `${"a".repeat(252)}.pdf`, contentType: "application/pdf" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("media_invalid");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(copies()).toHaveLength(0);
    expect(messageRow).toBeUndefined();
  });

  it("accepts a filename of exactly 255 UTF-8 bytes", async () => {
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "MEDIA12" }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.OUT12" }] }));
    const res = await post({
      contactId: "c1",
      body: "here",
      attachment: { ...attachment, filename: `${"a".repeat(251)}.pdf`, contentType: "application/pdf" },
    });
    expect(res.status).toBe(200);
  });

  it.each([
    ["a right-to-left override", "invoice\u202efdp.exe", "invoicefdp.exe"],
    ["a C1 control", "quo\u0085te.pdf", "quote.pdf"],
    ["a line separator", "quo\u2028te.pdf", "quote.pdf"],
  ])("strips %s from the filename sent to Meta", async (_label, filename, expected) => {
    // With the override left in, the first name displays on the customer's
    // phone as "invoiceexe.pdf", under the business's own name.
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "MEDIA13" }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.OUT13" }] }));
    const res = await post({
      contactId: "c1",
      body: "here",
      attachment: { ...attachment, filename, contentType: "application/pdf" },
    });
    expect(res.status).toBe(200);
    const sent = JSON.parse(graphCalls()[1]!.init.body as string).document.filename as string;
    expect(sent).toBe(expected);
    expect(((graphCalls()[0]!.init.body as FormData).get("file") as File).name).toBe(expected);
  });

  it("replaces a lone surrogate, so the multipart name and document.filename agree", async () => {
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "MEDIA14" }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.OUT14" }] }));
    const res = await post({
      contactId: "c1",
      body: "here",
      attachment: { ...attachment, filename: "a\uD83D.pdf", contentType: "application/pdf" },
    });
    expect(res.status).toBe(200);
    const sent = JSON.parse(graphCalls()[1]!.init.body as string).document.filename as string;
    const uploaded = ((graphCalls()[0]!.init.body as FormData).get("file") as File).name;
    expect(sent).toBe("a\ufffd.pdf");
    expect(uploaded).toBe(sent);
  });

  it("falls back to `file` when stripping leaves nothing", async () => {
    // Neither character is whitespace to String.prototype.trim, so the route's
    // shape check admits the name; only the strip empties it.
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "MEDIA15" }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.OUT15" }] }));
    const res = await post({
      contactId: "c1",
      body: "here",
      attachment: { ...attachment, filename: "\u202e\u200b", contentType: "application/pdf" },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(graphCalls()[1]!.init.body as string).document.filename).toBe("file");
  });

  it("strips CR/LF and other control characters from the filename sent to Meta", async () => {
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "MEDIA10" }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.OUT10" }] }));
    const res = await post({
      contactId: "c1",
      body: "here",
      attachment: { ...attachment, filename: "quote\r\nX-Evil: 1.pdf", contentType: "application/pdf" },
    });
    expect(res.status).toBe(200);
    const sent = JSON.parse(graphCalls()[1]!.init.body as string).document.filename as string;
    expect(sent).toBe("quoteX-Evil: 1.pdf");
    expect(((graphCalls()[0]!.init.body as FormData).get("file") as File).name).toBe(sent);
  });

  it("counts the caption in code points: 600 emoji go on Cloud", async () => {
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "MEDIA8" }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.OUT8" }] }));
    const res = await post({
      contactId: "c1",
      body: "😀".repeat(600),
      attachment: { ...attachment, filename: "q.pdf", contentType: "application/pdf" },
    });
    expect(res.status).toBe(200);
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

  it("sends an H.264 MP4 as a video by media id, caption omitted when there is no text", async () => {
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "MEDIAV" }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.V1" }] }));
    const res = await post({ contactId: "c1", body: "", attachment: h264 });
    expect(res.status).toBe(200);

    const [upload, send] = graphCalls();
    expect(upload!.url).toMatch(/\/PN1\/media$/);
    expect(((upload!.init.body as FormData).get("file") as File).type).toBe("video/mp4");
    const body = JSON.parse(send!.init.body as string);
    expect(body).toEqual({
      messaging_product: "whatsapp",
      to: "27821234567",
      type: "video",
      video: { id: "MEDIAV" },
    });
    expect(messageRow?.media).toMatchObject({ kind: "video", mimeType: "video/mp4", filename: "clip.mp4" });
  });

  it("refuses an HEVC MP4 with video_codec_unsupported before any Graph call — the upload never happens", async () => {
    const res = await post({ contactId: "c1", body: "here", attachment: hevc });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("video_codec_unsupported");
    expect(json.error).toContain("HEVC (H.265)");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(copies()).toHaveLength(0);
    expect(messageRow).toBeUndefined();
  });

  it("refuses garbage labelled video/mp4 as media_invalid before any Graph call", async () => {
    const res = await post({
      contactId: "c1",
      body: "here",
      attachment: { filename: "clip.mp4", contentType: "video/mp4", bytes: Buffer.from([0, 1, 2]) },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("media_invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Documents over Meta's 100 MB are refused by their real size on the staged
  // path — route.staged.test.ts. Over this base64 path the middleware body cap
  // (next.config.ts) bounds a request long before that.

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
    expect(copies()).toHaveLength(0);
    expect(messageRow).toBeUndefined();
  });

  it("hands the bridge its media unchanged and writes `media` on the row, not `attachment`", async () => {
    subAccountDoc = { whatsappEnabledByAgency: true, whatsappProvider: "bridge" };
    checkWhatsappReadiness.mockResolvedValue({ ready: true, provider: "bridge" });
    getBridgeCreds.mockResolvedValue({ baseUrl: "http://b:1", token: "t", webhookSecret: "w" });
    sendWhatsappBridge.mockResolvedValue({ ok: true, messageId: "3EB0" });

    const res = await post({ contactId: "c1", body: "here", attachment });
    expect(res.status).toBe(200);
    // Encoded for the bridge's JSON wire at the last step, from the staged bytes.
    expect(sendWhatsappBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        media: { filename: "site-photo.png", contentType: "image/png", dataBase64: PNG_BYTES.toString("base64") },
      }),
    );
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
    expect(copies()).toHaveLength(1);
  });

  it("refuses an HEVC MP4 on the bridge rail before the bridge client is called", async () => {
    subAccountDoc = { whatsappEnabledByAgency: true, whatsappProvider: "bridge" };
    checkWhatsappReadiness.mockResolvedValue({ ready: true, provider: "bridge" });
    getBridgeCreds.mockResolvedValue({ baseUrl: "http://b:1", token: "t", webhookSecret: "w" });

    const res = await post({ contactId: "c1", body: "here", attachment: hevc });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("video_codec_unsupported");
    expect(sendWhatsappBridge).not.toHaveBeenCalled();
    expect(messageRow).toBeUndefined();
  });

  it("hands the bridge an H.264 MP4 unchanged", async () => {
    subAccountDoc = { whatsappEnabledByAgency: true, whatsappProvider: "bridge" };
    checkWhatsappReadiness.mockResolvedValue({ ready: true, provider: "bridge" });
    getBridgeCreds.mockResolvedValue({ baseUrl: "http://b:1", token: "t", webhookSecret: "w" });
    sendWhatsappBridge.mockResolvedValue({ ok: true, messageId: "3EBV" });

    const res = await post({ contactId: "c1", body: "here", attachment: h264 });
    expect(res.status).toBe(200);
    expect(sendWhatsappBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        media: { filename: "clip.mp4", contentType: "video/mp4", dataBase64: h264.bytes.toString("base64") },
      }),
    );
    expect(messageRow?.media).toMatchObject({ kind: "video", filename: "clip.mp4" });
  });

  it("marks the row store_failed — never fetch_failed — when the send succeeded but the copy failed", async () => {
    subAccountDoc = { whatsappEnabledByAgency: true, whatsappProvider: "bridge" };
    checkWhatsappReadiness.mockResolvedValue({ ready: true, provider: "bridge" });
    getBridgeCreds.mockResolvedValue({ baseUrl: "http://b:1", token: "t", webhookSecret: "w" });
    sendWhatsappBridge.mockResolvedValue({ ok: true, messageId: "3EB1" });
    bucketFake.copyThrows = new Error("bucket down");

    const res = await post({ contactId: "c1", body: "here", attachment });
    // The customer got the file. The row must still say a file went, and
    // must not read "download failed" — an operator would resend it.
    expect(res.status).toBe(200);
    expect(messageRow?.media).toBeUndefined();
    expect(messageRow?.mediaDropped).toBe("store_failed");
  });

  it("answers 400 and sends nothing when Storage cannot be resolved at all", async () => {
    subAccountDoc = { whatsappEnabledByAgency: true, whatsappProvider: "bridge" };
    checkWhatsappReadiness.mockResolvedValue({ ready: true, provider: "bridge" });
    getBridgeCreds.mockResolvedValue({ baseUrl: "http://b:1", token: "t", webhookSecret: "w" });
    bucketFake.getStorageThrows = new Error("The default Firebase app does not exist");

    const res = await post({ contactId: "c1", body: "here", attachment });
    expect(res.status).toBe(400);
    expect(sendWhatsappBridge).not.toHaveBeenCalled();
    expect(messageRow).toBeUndefined();
  });

  it("writes neither media field on a plain text row", async () => {
    fetchMock.mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.T" }] }));
    const res = await post({ contactId: "c1", body: "just text" });
    expect(res.status).toBe(200);
    expect(messageRow).not.toHaveProperty("media");
    expect(messageRow).not.toHaveProperty("mediaDropped");
    expect(messageRow).not.toHaveProperty("attachment");
    expect(copies()).toHaveLength(0);
  });
});
