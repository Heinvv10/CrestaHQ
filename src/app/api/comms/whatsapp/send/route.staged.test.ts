import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { whatsappMediaPath } from "@/lib/comms/whatsapp/media-storage";

/**
 * The STAGED attachment form through the whole seam: route → staged-upload
 * (real) → conversation send → dispatcher → cloud client → Graph (fetch
 * mocked), with Storage mocked as an in-memory bucket so every read, copy
 * and delete is observable.
 *
 * What is under test is the part a client can lie about: which object the
 * stagedId reaches (tenancy), what the object really is (metadata over the
 * claim), and that the staged object never outlives the send.
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

interface StoredObject {
  bytes: Buffer;
  contentType: string;
  generation: number;
  /** Metadata size when it should differ from the bytes (a huge object never materialised). */
  size?: number;
}
let objects: Map<string, StoredObject>;
let log: string[];
let copyThrows: Error | null;

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
vi.mock("@/lib/comms/twilio", () => ({ sendWhatsappForSubAccount: vi.fn() }));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: (...a: unknown[]) => upsertConversationForMessage(...a),
}));
vi.mock("@/lib/reviews/review-ask", () => ({
  askOutcomeOf: () => "not_a_review_ask",
  logInboxReviewAsk: async () => undefined,
}));
vi.mock("firebase-admin/storage", () => ({
  getStorage: () => ({
    bucket: () => {
      const file = (path: string, opts: { generation?: number } = {}) => {
        const live = () => {
          const o = objects.get(path);
          if (!o || (opts.generation !== undefined && o.generation !== opts.generation)) {
            throw Object.assign(new Error("No such object"), { code: 404 });
          }
          return o;
        };
        return {
          name: path,
          getMetadata: async () => {
            log.push(`stat ${path}`);
            const o = live();
            return [{ size: String(o.size ?? o.bytes.length), contentType: o.contentType, generation: String(o.generation) }];
          },
          createReadStream: () => {
            log.push(`read ${path}@${opts.generation}`);
            const o = live();
            const chunks: Buffer[] = [];
            for (let i = 0; i < o.bytes.length; i += 1 << 20) chunks.push(o.bytes.subarray(i, i + (1 << 20)));
            return Readable.from(chunks);
          },
          copy: async (dest: { name: string }) => {
            log.push(`copy ${path}@${opts.generation} -> ${dest.name}`);
            if (copyThrows) throw copyThrows;
            objects.set(dest.name, { ...live() });
          },
          delete: async () => {
            log.push(`delete ${path}`);
            objects.delete(path);
          },
          save: async () => {
            log.push(`save ${path}`);
          },
        };
      };
      return { file };
    },
  }),
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminApp: () => ({ name: "test-app" }),
  getAdminDb: () => ({
    doc: () => ({
      get: async () => ({ exists: subAccountDoc !== undefined, data: () => subAccountDoc }),
    }),
    collection: (name: string) => {
      if (name === "contacts") {
        return {
          doc: () => ({
            collection: (sub: string) => ({
              add: async () => undefined,
              doc: () => ({
                set: async (data: Record<string, unknown>) => {
                  if (sub === "whatsappMessages") messageRow = data;
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

const STAGED_ID = "AbCdEfGhIjKlMnOpQrStUv_-";
const OWN_PATH = `whatsapp-staging/ag1/sa1/u1/${STAGED_ID}`;
const creds = { phoneNumberId: "PN1", wabaId: "WA1", accessToken: "EAAG" };

function stage(path: string, bytes: Buffer, contentType: string, extra: Partial<StoredObject> = {}) {
  objects.set(path, { bytes, contentType, generation: 7, ...extra });
}

function post(attachment: Record<string, unknown>, body = "here") {
  return POST(
    new Request("https://crm.test/api/comms/whatsapp/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contactId: "c1", body, attachment }),
    }) as never,
  );
}

const staged = (extra: Record<string, unknown> = {}) => ({
  stagedId: STAGED_ID,
  filename: "quote.pdf",
  contentType: "application/pdf",
  ...extra,
});

function graphOk(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function video(name: string): Buffer {
  return readFileSync(join(__dirname, "../../../../../lib/comms/whatsapp/__fixtures__/video", name));
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET", "test-bucket");
  messageRow = undefined;
  objects = new Map();
  log = [];
  copyThrows = null;
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

describe("POST /api/comms/whatsapp/send — staged attachment", () => {
  it("sends a 100 MB document on Cloud: Graph gets all of it, the thread copy is a Storage copy, the staged object is gone", async () => {
    const doc = Buffer.alloc(100_000_000, 7);
    stage(OWN_PATH, doc, "application/pdf");
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "MEDIA1" }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.BIG" }] }));

    const res = await post(staged(), "your quote");
    expect(res.status).toBe(200);

    const [upload, send] = fetchMock.mock.calls;
    expect(upload![0]).toMatch(/\/PN1\/media$/);
    const file = (upload![1].body as FormData).get("file") as File;
    expect(file.size).toBe(100_000_000);
    expect(file.type).toBe("application/pdf");
    expect(file.name).toBe("quote.pdf");
    expect(JSON.parse(send![1].body as string)).toMatchObject({
      type: "document",
      document: { id: "MEDIA1", caption: "your quote", filename: "quote.pdf" },
    });

    const dest = whatsappMediaPath({ agencyId: "ag1", subAccountId: "sa1", contactId: "c1", messageDocId: "wamid.BIG" });
    // Copied by Storage from the checked generation — no re-upload of bytes.
    expect(log).toContain(`copy ${OWN_PATH}@7 -> ${dest}`);
    expect(log.some((l) => l.startsWith("save "))).toBe(false);
    expect(messageRow?.media).toEqual({
      kind: "document",
      mimeType: "application/pdf",
      filename: "quote.pdf",
      sizeBytes: 100_000_000,
      storagePath: dest,
    });
    expect(objects.has(OWN_PATH)).toBe(false);
    expect(objects.has(dest)).toBe(true);
  });

  it.each([
    ["another user", "whatsapp-staging/ag1/sa1/u2/"],
    ["another sub-account", "whatsapp-staging/ag1/sa2/u1/"],
    ["another agency", "whatsapp-staging/ag2/sa1/u1/"],
  ])("cannot reach an object staged by %s: refused, nothing sent, their object untouched", async (_l, prefix) => {
    const theirs = `${prefix}${STAGED_ID}`;
    stage(theirs, Buffer.from("%PDF-1.4"), "application/pdf");

    const res = await post(staged());
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("media_invalid");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendWhatsappBridge).not.toHaveBeenCalled();
    expect(messageRow).toBeUndefined();
    expect(objects.has(theirs)).toBe(true);
    // Only ever the caller's own path was looked at.
    expect(log.every((l) => l.includes(OWN_PATH))).toBe(true);
  });

  it("cannot name another user's object by its full path", async () => {
    const theirs = `whatsapp-staging/ag1/sa1/u2/${STAGED_ID}`;
    stage(theirs, Buffer.from("%PDF-1.4"), "application/pdf");
    const res = await post(staged({ stagedId: theirs }));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(objects.has(theirs)).toBe(true);
    expect(log).toEqual([]);
  });

  it.each([
    ["a path climbing out of its segment", "../u2/AbCdEfGhIjKlMnOpQr"],
    ["a full path", `u2/${STAGED_ID}`],
    ["a short id", "abc"],
    ["a non-string", 42],
  ])("refuses %s as a stagedId without touching Storage", async (_l, stagedId) => {
    const res = await post(staged({ stagedId }));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  it("takes the object's real size over the client's claim: 200 MB behind a '1 MB' upload is refused before any read", async () => {
    // The upload URL was issued against a declared 1 MB; what arrived is 200 MB.
    stage(OWN_PATH, Buffer.alloc(1), "application/pdf", { size: 200_000_000 });
    const res = await post(staged({ sizeBytes: 1_000_000 }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("media_too_large");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.some((l) => l.startsWith("read "))).toBe(false);
    expect(objects.has(OWN_PATH)).toBe(false);
  });

  it("takes the object's real type over the client's claim", async () => {
    stage(OWN_PATH, Buffer.from("<svg/>"), "image/svg+xml");
    const res = await post(staged({ contentType: "application/pdf" }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("media_unsupported_type");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a real PNG under its REAL type even when the client claimed a PDF", async () => {
    stage(OWN_PATH, Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png");
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "MEDIA2" }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.P" }] }));
    const res = await post(staged({ filename: "site.png", contentType: "application/pdf" }));
    expect(res.status).toBe(200);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body as string).type).toBe("image");
    expect(messageRow?.media).toMatchObject({ kind: "image", mimeType: "image/png" });
  });

  it("refuses a document over Meta's 100 MB", async () => {
    stage(OWN_PATH, Buffer.alloc(1), "application/pdf", { size: 100_000_001 });
    const res = await post(staged());
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("media_too_large");
  });

  it("refuses a staged HEVC video via the codec check with zero Graph calls, and deletes it", async () => {
    stage(OWN_PATH, video("hevc-hvc1-aac.mp4"), "video/mp4");
    const res = await post(staged({ filename: "clip.mp4", contentType: "video/mp4" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("video_codec_unsupported");
    expect(json.error).toContain("HEVC (H.265)");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(messageRow).toBeUndefined();
    expect(objects.has(OWN_PATH)).toBe(false);
  });

  it("deletes the staged object when Graph refuses the upload, and stores no copy", async () => {
    stage(OWN_PATH, Buffer.from("%PDF-1.4"), "application/pdf");
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, text: async () => "bad", json: async () => ({}) });
    const res = await post(staged());
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("media_upload_failed");
    expect(log.some((l) => l.startsWith("copy "))).toBe(false);
    expect(objects.has(OWN_PATH)).toBe(false);
    expect(log.at(-1)).toBe(`delete ${OWN_PATH}`);
  });

  it("deletes the staged object when the send itself throws", async () => {
    stage(OWN_PATH, Buffer.from("%PDF-1.4"), "application/pdf");
    upsertConversationForMessage.mockRejectedValueOnce(new Error("firestore down"));
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "MEDIA3" }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.T" }] }));
    await expect(post(staged())).rejects.toThrow("firestore down");
    expect(objects.has(OWN_PATH)).toBe(false);
  });

  it("marks the row store_failed when the Storage copy fails, and still deletes the staged object", async () => {
    stage(OWN_PATH, Buffer.from("%PDF-1.4"), "application/pdf");
    copyThrows = new Error("copy refused");
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "MEDIA4" }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.C" }] }));
    const res = await post(staged());
    expect(res.status).toBe(200);
    expect(messageRow?.mediaDropped).toBe("store_failed");
    expect(objects.has(OWN_PATH)).toBe(false);
  });

  it("answers 400 'attach it again' for an id with no object (expired, or already sent)", async () => {
    const res = await post(staged());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Attach the file again");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a body carrying both stagedId and dataBase64", async () => {
    stage(OWN_PATH, Buffer.from("%PDF-1.4"), "application/pdf");
    const res = await post(staged({ dataBase64: "AAEC" }));
    expect(res.status).toBe(400);
    expect(log).toEqual([]);
  });

  it("refuses 9 MiB on the bridge by its real size before reading it; sends a small one as base64", async () => {
    subAccountDoc = { whatsappEnabledByAgency: true, whatsappProvider: "bridge" };
    checkWhatsappReadiness.mockResolvedValue({ ready: true, provider: "bridge" });
    getBridgeCreds.mockResolvedValue({ baseUrl: "http://b:1", token: "t", webhookSecret: "w" });
    stage(OWN_PATH, Buffer.alloc(1), "application/pdf", { size: 9 << 20 });
    const big = await post(staged());
    expect(big.status).toBe(400);
    expect((await big.json()).code).toBe("media_too_large");
    expect(log.some((l) => l.startsWith("read "))).toBe(false);
    expect(sendWhatsappBridge).not.toHaveBeenCalled();

    sendWhatsappBridge.mockResolvedValue({ ok: true, messageId: "3EB0" });
    stage(OWN_PATH, Buffer.from([0, 1, 2]), "application/pdf");
    const small = await post(staged());
    expect(small.status).toBe(200);
    expect(sendWhatsappBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        media: { filename: "quote.pdf", contentType: "application/pdf", dataBase64: "AAEC" },
      }),
    );
    expect(objects.has(OWN_PATH)).toBe(false);
  });

  it("pins the read to the generation it checked: an object replaced after the check is not sent", async () => {
    stage(OWN_PATH, Buffer.from("%PDF-1.4"), "application/pdf");
    const original = objects.get(OWN_PATH)!;
    // Replace the object the moment its metadata has been read.
    const realGet = objects.get.bind(objects);
    let stats = 0;
    objects.get = (k: string) => {
      const o = realGet(k);
      if (k === OWN_PATH && o && log.at(-1)?.startsWith("stat ") && stats++ === 0) {
        objects.set(OWN_PATH, { ...original, bytes: Buffer.alloc(8), generation: 8 });
        return o;
      }
      return o;
    };
    const res = await post(staged());
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toContain(`read ${OWN_PATH}@7`);
  });
});
