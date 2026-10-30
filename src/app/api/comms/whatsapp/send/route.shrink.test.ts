import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { whatsappMediaPath } from "@/lib/comms/whatsapp/media-storage";
import { bucketFake, resetBucketFake, stageObject } from "@/test/staged-bucket";
import { buildExif, FIXTURE_MAKERNOTE, FIXTURE_SERIAL, ifd1Offset, withApp1 } from "@/test/exif-fixture";

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
// The send and decode budgets, swappable per test; `decodePeak` is the most
// decode memory ever reserved at once.
type Budget = import("@/lib/comms/whatsapp/media-budget").ByteBudget;
const held = vi.hoisted(() => ({
  budget: null as unknown as Budget,
  decode: null as unknown as Budget,
  decodePeak: 0,
}));
vi.mock("@/lib/comms/whatsapp/media-budget", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/comms/whatsapp/media-budget")>();
  held.budget = real.stagedMediaBudget;
  held.decode = real.imageDecodeBudget;
  return {
    ...real,
    stagedMediaBudget: { acquire: (b: number) => held.budget.acquire(b), inFlight: () => held.budget.inFlight() },
    imageDecodeBudget: {
      acquire: async (b: number) => {
        const release = await held.decode.acquire(b);
        held.decodePeak = Math.max(held.decodePeak, held.decode.inFlight());
        return release;
      },
      inFlight: () => held.decode.inFlight(),
    },
  };
});
// Real sharp, counted: a file refused by its magic bytes must never reach it.
const sharpCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock("sharp", async (importOriginal) => {
  const real = (await importOriginal<{ default: typeof sharp }>()).default;
  const counted = (...a: Parameters<typeof real>) => {
    sharpCalls.n += 1;
    return real(...a);
  };
  return { default: Object.assign(counted, real) };
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
import { createByteBudget, IMAGE_DECODE_BUDGET_BYTES } from "@/lib/comms/whatsapp/media-budget";

const STAGED_ID = "AbCdEfGhIjKlMnOpQrStUv_-";
const OWN_PATH = `whatsapp-staging/ag1/sa1/u1/${STAGED_ID}`;
const TAKEN = "2026:09:19 10:11:12";
const GPS = {
  IFD2: { DateTimeOriginal: TAKEN },
  IFD3: { GPSLatitudeRef: "S", GPSLatitude: "26/1 12/1 0/1" },
};

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

/**
 * The fixture's GPS latitude (26/1 12/1 0/1 as three RATIONALs, in either
 * TIFF byte order) and its DateTimeOriginal, read out of an EXIF block.
 */
function exifOf(exif?: Buffer) {
  const rationals = (le: boolean) => {
    const b = Buffer.alloc(24);
    [26, 1, 12, 1, 0, 1].forEach((v, i) => (le ? b.writeUInt32LE(v, i * 4) : b.writeUInt32BE(v, i * 4)));
    return b;
  };
  return {
    gps: !!exif && (exif.includes(rationals(true)) || exif.includes(rationals(false))),
    taken: !!exif && exif.includes(Buffer.from(TAKEN)),
  };
}

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
  held.decodePeak = 0;
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
  it("shrinks an over-cap phone JPEG to the Cloud cap, upright, KEEPING its GPS and capture time; the thread copy IS the sent bytes", async () => {
    const inMeta = await sharp(phoneJpeg).metadata();
    expect(phoneJpeg.length).toBeGreaterThan(8 << 20);
    expect(inMeta.orientation).toBe(6);
    expect(exifOf(inMeta.exif)).toEqual({ gps: true, taken: true });
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
    // Kept at the business's request — and counted in the 5,000,000 above.
    expect(exifOf(out.exif)).toEqual({ gps: true, taken: true });
    expect(out.orientation).toBe(1);

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

  it("keeps only the whitelisted EXIF: GPS and capture time go; the IFD1 thumbnail, MakerNote and serial do not", async () => {
    // The thumbnail is a DIFFERENT picture from the photo — what a crop would hide.
    const thumbnail = await sharp({ create: { width: 48, height: 32, channels: 3, background: "#ff00ff" } })
      .jpeg({ quality: 90 })
      .toBuffer();
    const base = await sharp(photoPixels(800, 600), { raw: { width: 800, height: 600, channels: 3 } })
      .jpeg({ quality: 90 })
      .toBuffer();
    const camera = withApp1(base, buildExif({ orientation: 1, thumbnail }));
    const inMeta = await sharp(camera).metadata();
    expect(exifOf(inMeta.exif)).toEqual({ gps: true, taken: true });
    expect(ifd1Offset(inMeta.exif!)).not.toBe(0);
    expect(camera.includes(thumbnail)).toBe(true);
    override.imageCap = camera.length - 1;
    stageObject(OWN_PATH, camera, "image/jpeg");
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "M8" }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.S8" }] }));
    expect((await post("site.jpg")).status).toBe(200);

    const sent = await sentToGraph();
    const out = await sharp(sent).metadata();
    expect(exifOf(out.exif)).toEqual({ gps: true, taken: true });
    expect(ifd1Offset(out.exif!)).toBe(0);
    expect(sent.includes(thumbnail)).toBe(false);
    expect(sent.includes(thumbnail.subarray(-64))).toBe(false);
    expect(sent.includes(FIXTURE_MAKERNOTE)).toBe(false);
    expect(sent.includes(Buffer.from(FIXTURE_SERIAL))).toBe(false);
    expect(storedCopy("wamid.S8")!.bytes.equals(sent)).toBe(true);
  });

  it("turns a rotated-EXIF photo's pixels upright and writes Orientation 1, so it is not turned twice", async () => {
    // 400×200 landscape, top half red, bottom half blue, tagged Orientation 6
    // (display rotated 90° clockwise): upright it is 200×400, red on the RIGHT.
    const px = Buffer.alloc(400 * 200 * 3);
    for (let i = 0; i < 400 * 200; i++) {
      const top = i < 400 * 100;
      px[i * 3] = top ? 220 : 20;
      px[i * 3 + 2] = top ? 20 : 220;
    }
    const tagged = await sharp(px, { raw: { width: 400, height: 200, channels: 3 } })
      .jpeg({ quality: 95 })
      .withExif(GPS)
      .withMetadata({ orientation: 6 })
      .toBuffer();
    override.imageCap = tagged.length - 1;
    stageObject(OWN_PATH, tagged, "image/jpeg");
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "M7" }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.S7" }] }));
    expect((await post("rotated.jpg")).status).toBe(200);

    const sent = await sentToGraph();
    const meta = await sharp(sent).metadata();
    expect([meta.width, meta.height, meta.orientation]).toEqual([200, 400, 1]);
    // Raw stored pixels, read without applying any orientation.
    const { data } = await sharp(sent).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => [data[(y * 200 + x) * 3]!, data[(y * 200 + x) * 3 + 2]!];
    const [rightR, rightB] = at(190, 200);
    const [leftR, leftB] = at(10, 200);
    expect(rightR).toBeGreaterThan(rightB);
    expect(leftB).toBeGreaterThan(leftR);
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
    expect(exifOf((await sharp(sent).metadata()).exif)).toEqual({ gps: true, taken: true });
    const rowId = String((messageRow?.media as { storagePath: string }).storagePath.split("/").pop());
    expect(storedCopy(rowId)!.bytes.equals(sent)).toBe(true);
  });

  it("reserves decode memory from the photo's header in the decode budget, not the send budget", async () => {
    // 4000×3000 RGB JPEG, decoded at full scale: 36 MB of pixels + 60 MB
    // working memory + the input copy. With 250 MB of 300 already held, it
    // cannot fit — while a flat "file size" estimate would.
    const realDecode = held.decode;
    held.decode = createByteBudget(IMAGE_DECODE_BUDGET_BYTES, 20);
    const hold = await held.decode.acquire(250_000_000);
    try {
      stageObject(OWN_PATH, phoneJpeg, "image/jpeg");
      const res = await post("IMG_0004.jpg");
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("30");
      expect((await res.json()).code).toBe("media_busy");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(held.budget.inFlight()).toBe(0);
    } finally {
      hold?.();
      held.decode = realDecode;
    }
  });

  it("lets two shrinks and a 100 MB document run at once: the send budget holds only file bytes", async () => {
    const OTHER = "ZyXwVuTsRqPoNmLkJiHgFe_-";
    const DOC = "DoCuMeNtDoCuMeNtDoCuMe__";
    const pathOf = (id: string) => `whatsapp-staging/ag1/sa1/u1/${id}`;
    stageObject(OWN_PATH, phoneJpeg, "image/jpeg");
    stageObject(pathOf(OTHER), phoneJpeg, "image/jpeg");
    stageObject(pathOf(DOC), Buffer.alloc(100_000_000, 7), "application/pdf");
    // Graph holds every upload open until all three have arrived.
    const waiting: Array<() => void> = [];
    let uploads = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/media")) {
        uploads += 1;
        await new Promise<void>((r) => waiting.push(r));
        return graphOk({ id: `M${uploads}` });
      }
      return graphOk({ messages: [{ id: `wamid.C${Math.random()}` }] });
    });
    const send = (id: string, filename: string) =>
      POST(
        new Request("https://crm.test/api/comms/whatsapp/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ contactId: "c1", body: "", attachment: { stagedId: id, filename } }),
        }) as never,
      );
    const doc = send(DOC, "quote.pdf");
    const a = send(STAGED_ID, "a.jpg");
    const b = send(OTHER, "b.jpg");
    await vi.waitFor(() => expect(uploads).toBe(3), { timeout: 8_000 });
    // All three hold the send budget together: file bytes only.
    expect(held.budget.inFlight()).toBe(100_000_000 + 2 * phoneJpeg.length);
    // Both decodes were reserved at the same time, in their own budget.
    expect(held.decodePeak).toBeGreaterThan(2 * 90_000_000);
    expect(held.decode.inFlight()).toBe(0);
    waiting.forEach((r) => r());
    expect((await doc).status).toBe(200);
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
  }, 15_000);

  it.each([
    ["an SVG filter bomb declared JPEG, under the cap (sent-unchanged path)", "svg", "image/jpeg"],
    ["an SVG filter bomb declared WebP (shrink path)", "svg", "image/webp"],
    ["a TIFF declared JPEG", "tiff", "image/jpeg"],
    ["a GIF declared JPEG", "gif", "image/jpeg"],
    ["an AVIF declared WebP", "avif", "image/webp"],
  ])("refuses %s by its magic bytes — before sharp sees it, with zero Graph calls", async (_l, format, declared) => {
    const bytes =
      format === "svg"
        ? Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="7000" height="7000"><filter id="f">` +
              `${'<feGaussianBlur stdDeviation="200"/><feMorphology radius="200"/>'.repeat(20)}` +
              `</filter><rect width="100%" height="100%" filter="url(#f)"/></svg>`,
          )
        : await sharp(photoPixels(64, 48), { raw: { width: 64, height: 48, channels: 3 } })
            .toFormat(format as "tiff" | "gif" | "avif")
            .toBuffer();
    stageObject(OWN_PATH, bytes, declared);
    sharpCalls.n = 0;
    const res = await post("photo.jpg");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("media_unsupported_type");
    expect(json.error).toContain("isn't a JPEG, PNG or WebP photo");
    expect(sharpCalls.n).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bucketFake.objects.has(OWN_PATH)).toBe(false);
  });

  it("re-encodes a real PNG signed as a JPEG, under the cap, so what is sent and stored is a JPEG", async () => {
    const png = await sharp(photoPixels(640, 480), { raw: { width: 640, height: 480, channels: 3 } })
      .png()
      .withExif(GPS)
      .toBuffer();
    stageObject(OWN_PATH, png, "image/jpeg");
    fetchMock
      .mockResolvedValueOnce(graphOk({ id: "M6" }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: "wamid.S6" }] }));
    expect((await post("screenshot.jpg")).status).toBe(200);
    const sent = await sentToGraph();
    const file = (fetchMock.mock.calls[0]![1].body as FormData).get("file") as File;
    expect([file.type, file.name]).toEqual(["image/jpeg", "screenshot.jpg"]);
    expect(sent.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(sent.equals(png)).toBe(false);
    expect(storedCopy("wamid.S6")!.bytes.equals(sent)).toBe(true);
    expect(messageRow?.media).toMatchObject({ mimeType: "image/jpeg", sizeBytes: sent.length });
    expect(exifOf((await sharp(sent).metadata()).exif)).toEqual({ gps: true, taken: true });
  });

  it("refuses a large progressive JPEG by its header, with a message that says why", async () => {
    // 48 MP progressive: libjpeg would hold a 288 MB coefficient buffer.
    const big = await sharp({ create: { width: 8000, height: 6000, channels: 3, background: "#7a8b9c" } })
      .jpeg({ progressive: true })
      .toBuffer();
    expect((await sharp(big).metadata()).isProgressive).toBe(true);
    // Solid colour compresses to a small file; a cap just under it puts the
    // photo on the shrink path, as a detailed photo of this size would be.
    override.imageCap = big.length - 1;
    stageObject(OWN_PATH, big, "image/jpeg");
    const res = await post("export.jpg");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("media_too_large");
    expect(json.error).toContain("progressive JPEG");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(held.decode.inFlight()).toBe(0);
  });

  it("keeps a 253-byte extensionless name within 255 bytes once it becomes .jpg", async () => {
    subAccountDoc = { whatsappEnabledByAgency: true, whatsappProvider: "bridge" };
    checkWhatsappReadiness.mockResolvedValue({ ready: true, provider: "bridge" });
    getBridgeCreds.mockResolvedValue({ baseUrl: "http://b:1", token: "t", webhookSecret: "w" });
    sendWhatsappBridge.mockResolvedValue({ ok: true, messageId: "3EB0N" });
    stageObject(OWN_PATH, phoneJpeg, "image/jpeg");
    const name = "é".repeat(126) + "x"; // 253 bytes, no extension
    expect(Buffer.byteLength(name)).toBe(253);
    expect((await post(name)).status).toBe(200);
    const sent = (sendWhatsappBridge.mock.calls[0]![0].media as { filename: string }).filename;
    expect(Buffer.byteLength(sent)).toBeLessThanOrEqual(255);
    expect(sent).toBe(`${"é".repeat(125)}.jpg`);
  });
});
