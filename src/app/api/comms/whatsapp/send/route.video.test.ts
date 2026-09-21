import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { whatsappMediaPath } from "@/lib/comms/whatsapp/media-storage";
import { bucketFake, resetBucketFake, stageObject } from "@/test/staged-bucket";
import { FTYP, makeClips, type Clips } from "@/test/video-clips";

/**
 * Video transcoding through the whole seam: route → staged-upload (download
 * to a temp file) → ffmpeg (REAL) → conversation send → dispatcher → cloud
 * client → Graph (fetch mocked) or bridge client (mocked), with Storage as an
 * in-memory bucket. Every clip is made here with ffmpeg; nothing binary is
 * committed. Skipped, loudly, only where ffmpeg is absent — not on velo's CI.
 */

const requireUid = vi.fn();
const requireContactAccessible = vi.fn();
const checkWhatsappReadiness = vi.fn();
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
  getBridgeCreds: async () => ({ baseUrl: "http://b:1", token: "t", webhookSecret: "w" }),
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

// The host's answer, overridable: null leaves the real detection in charge.
const host = vi.hoisted(() => ({ videoTranscode: null as boolean | null }));
vi.mock("@/lib/comms/whatsapp/video-tools", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/comms/whatsapp/video-tools")>();
  return {
    ...real,
    videoTranscodeAvailable: async () => host.videoTranscode ?? (await real.videoTranscodeAvailable()),
  };
});
// A smaller rail video cap, so an "over the cap" clip can stay small.
const override = vi.hoisted(() => ({ videoCap: null as number | null }));
vi.mock("@/lib/comms/whatsapp/provider", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/comms/whatsapp/provider")>();
  return {
    ...real,
    capabilitiesFor: (p: Parameters<typeof real.capabilitiesFor>[0]) => {
      const caps = real.capabilitiesFor(p);
      return override.videoCap === null
        ? caps
        : { ...caps, maxMediaBytes: { ...caps.maxMediaBytes, video: override.videoCap } };
    },
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
import { stagedMediaBudget, videoTranscodeSlots } from "@/lib/comms/whatsapp/media-budget";
import { checkWhatsappVideoCodecs } from "@/lib/comms/whatsapp/video-codec";
import { detectVideoTools } from "@/lib/comms/whatsapp/video-tools";

const tools = await detectVideoTools();
if (!tools) console.warn("[route.video.test] ffmpeg/ffprobe NOT FOUND: the video transcode route tests are SKIPPED.");

const STAGED_ID = "AbCdEfGhIjKlMnOpQrStUv_-";
const OWN_PATH = `whatsapp-staging/ag1/sa1/u1/${STAGED_ID}`;

const base = mkdtempSync(join(tmpdir(), "vt-route-"));
const work = join(base, "work");
mkdirSync(work);
const savedTmp = process.env.TMPDIR;
process.env.TMPDIR = work;
let clips: Clips;
const acquire = vi.spyOn(videoTranscodeSlots, "acquire");

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

function graphAccepts(id: string) {
  fetchMock
    .mockResolvedValueOnce(graphOk({ id: `M-${id}` }))
    .mockResolvedValueOnce(graphOk({ messages: [{ id }] }));
}

/** The file Graph was given. */
function sentFile(): File {
  return (fetchMock.mock.calls[0]![1].body as FormData).get("file") as File;
}
const storedCopy = (messageDocId: string) =>
  bucketFake.objects.get(whatsappMediaPath({ agencyId: "ag1", subAccountId: "sa1", contactId: "c1", messageDocId }));

beforeAll(() => {
  if (tools) {
    const clipDir = join(base, "clips");
    mkdirSync(clipDir);
    clips = makeClips(clipDir);
  }
}, 120_000);

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET", "test-bucket");
  messageRow = undefined;
  host.videoTranscode = null;
  override.videoCap = null;
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
  // Whatever happened, the staged object, the budget and the temp files are all gone.
  expect(bucketFake.objects.has(OWN_PATH)).toBe(false);
  expect(stagedMediaBudget.inFlight()).toBe(0);
  expect(readdirSync(work)).toEqual([]);
});

afterAll(() => {
  process.env.TMPDIR = savedTmp;
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!tools)("POST /api/comms/whatsapp/send — video transcoding", () => {
  it("sends an H.264/AAC MP4 within the cap as it is: no transcode, and Storage copies the thread's copy", async () => {
    stageObject(OWN_PATH, clips.h264, "video/mp4");
    graphAccepts("wamid.V1");
    expect((await post("clip.mp4")).status).toBe(200);
    const file = sentFile();
    expect(Buffer.from(await file.arrayBuffer()).equals(clips.h264)).toBe(true);
    expect([file.name, file.type]).toEqual(["clip.mp4", "video/mp4"]);
    expect(acquire).not.toHaveBeenCalled();
    expect(bucketFake.log.some((l) => l.startsWith("copy "))).toBe(true);
  });

  it("converts an iPhone HEVC .mov to an H.264/AAC MP4 on Cloud; the thread's copy is the bytes sent", async () => {
    stageObject(OWN_PATH, clips.hevcMov, "video/quicktime");
    graphAccepts("wamid.V2");
    expect((await post("IMG_0042.MOV", "the leak")).status).toBe(200);
    const file = sentFile();
    const sent = Buffer.from(await file.arrayBuffer());
    expect([file.name, file.type]).toEqual(["IMG_0042.mp4", "video/mp4"]);
    expect(checkWhatsappVideoCodecs(sent)).toEqual({ ok: true });
    expect(sent.length).toBeLessThanOrEqual(16 << 20);
    expect(storedCopy("wamid.V2")!.bytes.equals(sent)).toBe(true);
    expect(bucketFake.log.some((l) => l.startsWith("copy "))).toBe(false);
    expect(messageRow?.media).toMatchObject({ kind: "video", mimeType: "video/mp4", filename: "IMG_0042.mp4", sizeBytes: sent.length });
  });

  it("fits an H.264 MP4 over the rail's video cap under it", async () => {
    override.videoCap = 400_000;
    stageObject(OWN_PATH, clips.h264Big, "video/mp4");
    graphAccepts("wamid.V3");
    expect((await post("big.mp4")).status).toBe(200);
    const sent = Buffer.from(await sentFile().arrayBuffer());
    expect(sent.length).toBeLessThanOrEqual(400_000);
    expect(checkWhatsappVideoCodecs(sent)).toEqual({ ok: true });
  });

  it("converts for the bridge at its 8 MiB cap, as base64 video/mp4 its own codec check accepts", async () => {
    subAccountDoc = { whatsappEnabledByAgency: true, whatsappProvider: "bridge" };
    checkWhatsappReadiness.mockResolvedValue({ ready: true, provider: "bridge" });
    sendWhatsappBridge.mockResolvedValue({ ok: true, messageId: "3EB0V" });
    stageObject(OWN_PATH, clips.hevcMov, "video/quicktime");
    expect((await post("IMG_0042.MOV")).status).toBe(200);
    const media = sendWhatsappBridge.mock.calls[0]![0].media as { filename: string; contentType: string; dataBase64: string };
    const sent = Buffer.from(media.dataBase64, "base64");
    expect([media.filename, media.contentType]).toEqual(["IMG_0042.mp4", "video/mp4"]);
    expect(sent.length).toBeLessThanOrEqual(8 << 20);
    expect(checkWhatsappVideoCodecs(sent)).toEqual({ ok: true });
  });

  it("holds only the rail's cap of the send budget for a video bigger than the whole budget", async () => {
    // 240 MB by Storage's word — over the 200 MB send budget, under the 250 MB
    // raw cap — but only a few bytes really there: it goes to disk, so it is
    // not refused as "busy"; the short read is what refuses it.
    stageObject(OWN_PATH, clips.hevcMov, "video/quicktime", { size: 240_000_000 });
    const res = await post("huge.mov");
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("media_invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 503 media_busy with Retry-After while another transcode holds the slot", async () => {
    const release = (await videoTranscodeSlots.acquire(1))!;
    try {
      stageObject(OWN_PATH, clips.hevcMov, "video/quicktime");
      const res = await post("IMG_0042.MOV");
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("30");
      expect((await res.json()).code).toBe("media_busy");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      release();
    }
  }, 30_000);

  it.each([
    ["a video over 180 s", () => clips.long, "video/quicktime", "media_too_large"],
    ["an HLS playlist labelled video/mp4", () => Buffer.concat([FTYP, Buffer.from("#EXTM3U\n#EXTINF:1,\n/etc/passwd\n")]), "video/mp4", "media_invalid"],
    ["an audio-only MP4", () => clips.audioOnly, "video/mp4", "media_invalid"],
  ])("refuses %s before anything reaches Graph", async (_l, bytes, type, code) => {
    stageObject(OWN_PATH, bytes(), type);
    const res = await post("x.mp4");
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe(code);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("on a host without ffmpeg — exactly the rules before transcoding existed", () => {
    beforeEach(() => {
      host.videoTranscode = false;
    });

    it("refuses a .mov as a type the rail does not send", async () => {
      stageObject(OWN_PATH, clips.hevcMov, "video/quicktime");
      const res = await post("IMG_0042.MOV");
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("media_unsupported_type");
    });

    it("refuses an HEVC MP4 by its codecs, and an MP4 over 16 MiB by its size", async () => {
      stageObject(OWN_PATH, clips.hevcMov, "video/mp4");
      const hevc = await post("clip.mp4");
      expect((await hevc.json()).code).toBe("video_codec_unsupported");
      stageObject(OWN_PATH, clips.h264, "video/mp4", { size: (16 << 20) + 1 });
      const big = await post("clip.mp4");
      expect((await big.json()).code).toBe("media_too_large");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
    });
  });
});
