import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { whatsappMediaPath } from "@/lib/comms/whatsapp/media-storage";
import { bucketFake, resetBucketFake, stageObject } from "@/test/staged-bucket";

/**
 * Photo shrinking through the whole seam: route → staged-upload → sharp
 * (real) → conversation send → dispatcher → cloud client → Graph (fetch
 * mocked) or bridge client (mocked), with Storage as an in-memory bucket.
 * Every image is generated here with sharp; nothing binary is committed.
 */

const requireUid = vi.fn();
const requireContactAccessible = vi.fn();
const checkWhatsappReadiness = vi.fn();
const getBridgeCreds = vi.fn();
const sendWhatsappBridge = vi.fn();
let fetchMock: ReturnType<typeof vi.fn>;
let subAccountDoc: Record<string, unknown> | undefined;
let messageRow: Record<string, unknown> | undefined;

vi.mock("@/lib/comms/route-auth", () => ({
  requireUid: (...a: unknown[]) => requireUid(...a),
  requireContactAccessible: (...a: unknown[]) => requireContactAccessible(...a),
}));
vi.mock("@/lib/comms/whatsapp/readiness", () => ({
  checkWhatsappReadiness: (...a: unknown[]) => checkWhatsappReadiness(...a),
}));
vi.mock("@/lib/comms/ai/agent", () => ({ getChannelConfig: async () => null }));
vi.mock("@/lib/comms/whatsapp/cloud-credentials", () => ({
  getWabaCreds: async () => ({ phoneNumberId: "PN1", wabaId: "WA1", accessToken: "EAAG" }),
}));
vi.mock("@/lib/comms/whatsapp/bridge-credentials", () => ({
  getBridgeCreds: (...a: unknown[]) => getBridgeCreds(...a),
}));
vi.mock("@/lib/comms/whatsapp/bridge-client", () => ({
  sendWhatsappBridge: (...a: unknown[]) => sendWhatsappBridge(...a),
}));
vi.mock("@/lib/comms/twilio", () => ({ sendWhatsappForSubAccount: vi.fn() }));
vi.mock("@/lib/server/conversations-service", () => ({ upsertConversationForMessage: async () => undefined }));
vi.mock("@/lib/reviews/review-ask", () => ({
  askOutcomeOf: () => "not_a_review_ask",
  logInboxReviewAsk: async () => undefined,
}));
vi.mock("firebase-admin/storage", async () => (await import("@/test/staged-bucket")).storageMock());

// A smaller rail image cap, for the tests that need the encoder to miss. Every
// consumer — sender resolution, the cloud client — reads it through here.
const override = vi.hoisted(() => ({ imageCap: null as number | null }));
vi.mock("@/lib/comms/whatsapp/provider", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/comms/whatsapp/provider")>();
  return {
    ...real,
    capabilitiesFor: (p: Parameters<typeof real.capabilitiesFor>[0]) => {
      const caps = real.capabilitiesFor(p);
      return override.imageCap === null
        ? caps
        : { ...caps, maxMediaBytes: { ...caps.maxMediaBytes, image: override.imageCap } };
    },
  };
});
const held = vi.hoisted(() => ({
  budget: null as unknown as import("@/lib/comms/whatsapp/media-budget").ByteBudget,
}));
vi.mock("@/lib/comms/whatsapp/media-budget", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/comms/whatsapp/media-budget")>();
  held.budget = real.stagedMediaBudget;
  return {
    ...real,
    stagedMediaBudget: { acquire: (b: number) => held.budget.acquire(b), inFlight: () => held.budget.inFlight() },
  };
});
vi.mock("@/lib/firebase/admin", () => ({
  getAdminApp: () => ({ name: "test-app" }),
  getAdminDb: () => ({
    doc: () => ({ get: async () => ({ exists: subAccountDoc !== undefined, data: () => subAccountDoc }) }),
    collection: (name: string) =>
      name === "contacts"
        ? {
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
          }
        : {
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
          },
  }),
}));

import { POST } from "./route";
import { createByteBudget } from "@/lib/comms/whatsapp/media-budget";

const STAGED_ID = "AbCdEfGhIjKlMnOpQrStUv_-";
const OWN_PATH = `whatsapp-staging/ag1/sa1/u1/${STAGED_ID}`;
const GPS = { IFD3: { GPSLatitudeRef: "S", GPSLatitude: "26/1 12/1 0/1" } };

function post(filename: string, body = "") {
  return POST(
    new Request("https://crm.test/api/comms/whatsapp/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contactId: "c1", body, attachment: { stagedId: STAGED_ID, filename } }),
    }) as never,
  );
}

const graphOk = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

/** Photo-like pixels: a gradient under noise, so JPEG sizes are realistic. */
function photoPixels(width: number, height: number): Buffer {
  const px = randomBytes(width * height * 3);
  for (let i = 0; i < px.length; i++) px[i] = (((i / 3) % width) * 150) / width + (px[i]! % 100);
  return px;
}

/** GPS IFD pointer tag 0x8825, in either byte order. */
const hasGps = (exif?: Buffer) =>
  !!exif && (exif.includes(Buffer.from([0x88, 0x25])) || exif.includes(Buffer.from([0x25, 0x88])));

/** The file Graph was given, and the thread copy's bytes. */
async function sentToGraph(): Promise<Buffer> {
  const file = (fetchMock.mock.calls[0]![1].body as FormData).get("file") as File;
  return Buffer.from(await file.arrayBuffer());
}
const storedCopy = (messageDocId: string) =>
  bucketFake.objects.get(whatsappMediaPath({ agencyId: "ag1", subAccountId: "sa1", contactId: "c1", messageDocId }));

/** 4000×3000 landscape, orientation 6 (display rotated to portrait), with GPS: ~13 MB, over both rails' caps. */
let phoneJpeg: Buffer;

beforeAll(async () => {
  phoneJpeg = await sharp(photoPixels(4000, 3000), { raw: { width: 4000, height: 3000, channels: 3 } })
    .jpeg({ quality: 100 })
    .withExif(GPS)
    .withMetadata({ orientation: 6 })
    .toBuffer();
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET", "test-bucket");
  messageRow = undefined;
  override.imageCap = null;
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
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("POST /api/comms/whatsapp/send — photo shrinking", () => {
  it("shrinks an over-cap phone JPEG to the Cloud cap, upright and without GPS; the thread copy IS the sent bytes", async () => {
    const inMeta = await sharp(phoneJpeg).metadata();
    expect(phoneJpeg.length).toBeGreaterThan(8 << 20);
    expect(inMeta.orientation).toBe(6);
    expect(hasGps(inMeta.exif)).toBe(true);
    stageObject(OWN_PATH, phoneJpeg, "image/jpeg");
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "M1" }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.S1" }] }));

    const res = await post("IMG_0001.JPEG", "the site");
    expect(res.status).toBe(200);

    const sent = await sentToGraph();
    const file = (fetchMock.mock.calls[0]![1].body as FormData).get("file") as File;
    expect(sent.length).toBeLessThanOrEqual(5_000_000);
    expect(file.type).toBe("image/jpeg");
    expect(file.name).toBe("IMG_0001.jpg");
    const out = await sharp(sent).metadata();
    expect(out.format).toBe("jpeg");
    // Orientation 6 on a 4000×3000 sensor image is a portrait photo.
    expect([out.width, out.height]).toEqual([1920, 2560]);
    expect(out.exif).toBeUndefined();
    expect(out.orientation).toBeUndefined();

    const stored = storedCopy("wamid.S1")!;
    expect(stored.bytes.equals(sent)).toBe(true);
    expect(stored.contentType).toBe("image/jpeg");
    expect(bucketFake.log.some((l) => l.startsWith("copy "))).toBe(false);
    expect(messageRow?.media).toEqual({
      kind: "image",
      mimeType: "image/jpeg",
      filename: "IMG_0001.jpg",
      sizeBytes: sent.length,
      storagePath: whatsappMediaPath({ agencyId: "ag1", subAccountId: "sa1", contactId: "c1", messageDocId: "wamid.S1" }),
    });
    expect(bucketFake.objects.has(OWN_PATH)).toBe(false);
    expect(held.budget.inFlight()).toBe(0);
  });

  it("sends an under-cap JPEG byte for byte — no recompression — and copies it by Storage", async () => {
    const small = await sharp(photoPixels(800, 600), { raw: { width: 800, height: 600, channels: 3 } })
      .jpeg({ quality: 90 })
      .withExif(GPS)
      .toBuffer();
    stageObject(OWN_PATH, small, "image/jpeg");
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "M2" }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.S2" }] }));

    expect((await post("small.jpeg")).status).toBe(200);
    expect((await sentToGraph()).equals(small)).toBe(true);
    const file = (fetchMock.mock.calls[0]![1].body as FormData).get("file") as File;
    expect(file.name).toBe("small.jpeg");
    expect(bucketFake.log.some((l) => l.startsWith("copy "))).toBe(true);
    expect(storedCopy("wamid.S2")!.bytes.equals(small)).toBe(true);
  });

  it("flattens a transparent PNG onto white, not black", async () => {
    const w = 2400;
    const h = 1800;
    const px = Buffer.alloc(w * h * 4);
    const noise = randomBytes(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      // Left half fully transparent black; right half opaque noise (keeps the file over 5 MB).
      const opaque = i % w >= w / 2;
      px[i * 4] = opaque ? noise[i * 3]! : 0;
      px[i * 4 + 1] = opaque ? noise[i * 3 + 1]! : 0;
      px[i * 4 + 2] = opaque ? noise[i * 3 + 2]! : 0;
      px[i * 4 + 3] = opaque ? 255 : 0;
    }
    const png = await sharp(px, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
    expect(png.length).toBeGreaterThan(5_000_000);
    stageObject(OWN_PATH, png, "image/png");
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "M3" }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.S3" }] }));

    expect((await post("logo.png")).status).toBe(200);
    const sent = await sentToGraph();
    const out = await sharp(sent).metadata();
    expect([out.format, out.channels]).toEqual(["jpeg", 3]);
    // The left quarter was fully transparent: white after flattening (black without it).
    const left = await sharp(sent).extract({ left: 0, top: 0, width: out.width! / 4, height: out.height! }).raw().toBuffer();
    expect(left.reduce((m, v) => Math.min(m, v), 255)).toBeGreaterThan(245);
  });

  it("converts a small WebP (a type neither rail sends) to JPEG", async () => {
    const webp = await sharp(photoPixels(640, 480), { raw: { width: 640, height: 480, channels: 3 } }).webp().toBuffer();
    stageObject(OWN_PATH, webp, "image/webp");
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "M4" }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.S4" }] }));
    expect((await post("photo.webp")).status).toBe(200);
    const file = (fetchMock.mock.calls[0]![1].body as FormData).get("file") as File;
    expect([file.type, file.name]).toEqual(["image/jpeg", "photo.jpg"]);
    expect((await sharp(await sentToGraph()).metadata()).format).toBe("jpeg");
  });

  it("refuses a decompression bomb (80 MP in a tiny WebP) by its header, with zero Graph calls", async () => {
    // WebP because it is always decoded (neither rail sends it); a small PNG
    // under the cap would go out untouched and never be decoded here at all.
    const bomb = await sharp({ create: { width: 10_000, height: 8_000, channels: 3, background: "#ffffff" } })
      .webp()
      .toBuffer();
    expect(bomb.length).toBeLessThan(1_000_000);
    stageObject(OWN_PATH, bomb, "image/webp");
    const res = await post("bomb.webp");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("media_too_large");
    expect(json.error).toContain("50 megapixels");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bucketFake.objects.has(OWN_PATH)).toBe(false);
    expect(held.budget.inFlight()).toBe(0);
  });

  it("steps quality, then size, down until it fits a cap the first encode misses", async () => {
    // At today's caps the first encode always fits (worst case, 2560² of pure
    // noise at q85, is ~4.3 MB); a smaller cap is what exercises the steps.
    override.imageCap = 250_000;
    stageObject(OWN_PATH, phoneJpeg, "image/jpeg");
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "M5" }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.S5" }] }));
    expect((await post("IMG_0005.jpg")).status).toBe(200);
    const sent = await sentToGraph();
    expect(sent.length).toBeLessThanOrEqual(250_000);
    expect((await sharp(sent).metadata()).height).toBeLessThan(2560);
  });

  it("refuses clearly, with zero Graph calls, when even the smallest encode is over the rail's cap", async () => {
    override.imageCap = 20_000;
    stageObject(OWN_PATH, phoneJpeg, "image/jpeg");
    const res = await post("IMG_0002.jpg");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("media_too_large");
    expect(json.error).toContain("can't be made small enough");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(messageRow).toBeUndefined();
    expect(bucketFake.objects.has(OWN_PATH)).toBe(false);
  });

  it("shrinks to the bridge's 8 MiB and sends it as base64 JPEG; the thread copy is what was sent", async () => {
    subAccountDoc = { whatsappEnabledByAgency: true, whatsappProvider: "bridge" };
    checkWhatsappReadiness.mockResolvedValue({ ready: true, provider: "bridge" });
    getBridgeCreds.mockResolvedValue({ baseUrl: "http://b:1", token: "t", webhookSecret: "w" });
    sendWhatsappBridge.mockResolvedValue({ ok: true, messageId: "3EB0S" });
    stageObject(OWN_PATH, phoneJpeg, "image/jpeg");

    expect((await post("IMG_0003.jpg")).status).toBe(200);
    const media = sendWhatsappBridge.mock.calls[0]![0].media as { filename: string; contentType: string; dataBase64: string };
    const sent = Buffer.from(media.dataBase64, "base64");
    expect([media.filename, media.contentType]).toEqual(["IMG_0003.jpg", "image/jpeg"]);
    expect(sent.length).toBeLessThanOrEqual(8 << 20);
    expect((await sharp(sent).metadata()).exif).toBeUndefined();
    const rowId = String((messageRow?.media as { storagePath: string }).storagePath.split("/").pop());
    expect(storedCopy(rowId)!.bytes.equals(sent)).toBe(true);
  });

  it("reserves decode memory for a photo it will shrink: a budget that fits the file alone answers busy", async () => {
    const real = held.budget;
    held.budget = createByteBudget(50_000_000, 20);
    try {
      stageObject(OWN_PATH, phoneJpeg, "image/jpeg");
      const res = await post("IMG_0004.jpg");
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe("media_busy");
      expect(bucketFake.log.some((l) => l.startsWith("read "))).toBe(false);
    } finally {
      held.budget = real;
    }
  });
});
