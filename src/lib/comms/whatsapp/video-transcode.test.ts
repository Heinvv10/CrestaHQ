import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { videoTranscodeSlots } from "./media-budget";
import { checkWhatsappVideoCodecs } from "./video-codec";
import { detectVideoTools, run } from "./video-tools";
import { fitVideo, guardedInput, mp4Filename, type VideoFit } from "./video-transcode";
import { CREATED, FTYP, LOCATION, makeClips, probeFile, type Clips } from "@/test/video-clips";

/**
 * The transcode against the host's REAL ffmpeg, on clips made here with it.
 * CI runs on velo, which has ffmpeg 6.1 on the runner user's PATH, so these
 * run there; on a machine without ffmpeg they are skipped, loudly.
 */
const tools = await detectVideoTools();
if (!tools) {
  console.warn("[video-transcode.test] ffmpeg/ffprobe NOT FOUND: every real-media test in this file is SKIPPED.");
}

const base = mkdtempSync(join(tmpdir(), "vt-test-"));
const clipDir = join(base, "clips");
/** fitVideo's temp directories land here (TMPDIR), so a leftover is countable. */
const work = join(base, "work");
mkdirSync(clipDir);
mkdirSync(work);
const savedTmp = process.env.TMPDIR;
process.env.TMPDIR = work;

let clips: Clips;
const MiB16 = 16 << 20;

const from = (bytes: Buffer) => async (dest: string) => writeFileSync(dest, bytes);
const ok = (fit: VideoFit) => {
  if (!fit.ok) throw new Error(`refused: ${fit.code} ${fit.error}`);
  return fit;
};
/** The output on disk, for ffprobe. */
function saved(bytes: Buffer, name: string): string {
  const path = join(clipDir, name);
  writeFileSync(path, bytes);
  return path;
}

const acquire = vi.spyOn(videoTranscodeSlots, "acquire");

beforeAll(() => {
  if (tools) clips = makeClips(clipDir);
}, 120_000);

afterEach(() => {
  // Every path — sent, transcoded, refused, timed out, thrown — leaves nothing behind.
  expect(readdirSync(work)).toEqual([]);
  acquire.mockClear();
});

afterAll(() => {
  process.env.TMPDIR = savedTmp;
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!tools)("fitVideo, with real ffmpeg", () => {
  it("sends an H.264/AAC MP4 within the cap unchanged, byte for byte, without transcoding", async () => {
    const fit = ok(await fitVideo(from(clips.h264), "video/mp4", MiB16));
    expect(fit.transcoded).toBe(false);
    expect(fit.bytes.equals(clips.h264)).toBe(true);
    expect(acquire).not.toHaveBeenCalled();
  });

  it("transcodes an iPhone HEVC .mov into an H.264/AAC MP4 that passes the codec check", async () => {
    expect(checkWhatsappVideoCodecs(clips.hevcMov).ok).toBe(false);
    const fit = ok(await fitVideo(from(clips.hevcMov), "video/quicktime", MiB16));
    expect(fit.transcoded).toBe(true);
    expect(checkWhatsappVideoCodecs(fit.bytes)).toEqual({ ok: true });
    const probed = probeFile(saved(fit.bytes, "hevc-out.mp4"));
    expect(probed.streams.map((s) => s.codec_name)).toEqual(["h264", "aac"]);
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("keeps capture time and location, and drops every other tag", async () => {
    const fit = ok(await fitVideo(from(clips.hevcMov), "video/quicktime", MiB16));
    const tags = probeFile(saved(fit.bytes, "meta-out.mp4")).format.tags ?? {};
    expect(tags.location).toBe(LOCATION);
    expect(tags["com.apple.quicktime.location.ISO6709"]).toBe(LOCATION);
    expect(tags.creation_time).toBe(CREATED);
    expect(fit.bytes.includes(Buffer.from("SECRET-"))).toBe(false);
    expect(clips.hevcMov.includes(Buffer.from("SECRET-"))).toBe(true);
  });

  it("keeps a location an iPhone wrote only as com.apple.quicktime.location.ISO6709", async () => {
    const fit = ok(await fitVideo(from(clips.appleLocMov), "video/quicktime", MiB16));
    const tags = probeFile(saved(fit.bytes, "apple-out.mp4")).format.tags ?? {};
    expect(tags["com.apple.quicktime.location.ISO6709"]).toBe(LOCATION);
  });

  it("transcodes an H.264 MP4 over the cap down to fit it", async () => {
    const cap = 400_000;
    expect(clips.h264Big.length).toBeGreaterThan(cap * 3);
    const fit = ok(await fitVideo(from(clips.h264Big), "video/mp4", cap));
    expect(fit.transcoded).toBe(true);
    expect(fit.bytes.length).toBeLessThanOrEqual(cap);
    expect(checkWhatsappVideoCodecs(fit.bytes)).toEqual({ ok: true });
  });

  it("refuses a cap too small to carry the clip at all, before transcoding", async () => {
    const fit = await fitVideo(from(clips.h264Big), "video/mp4", 40_000);
    expect(fit).toMatchObject({ ok: false, code: "media_too_large" });
    expect(acquire).not.toHaveBeenCalled();
  });

  it("refuses a video over 180 seconds before any transcode", async () => {
    const fit = await fitVideo(from(clips.long), "video/quicktime", MiB16);
    expect(fit).toMatchObject({ ok: false, code: "media_too_large" });
    expect(!fit.ok && fit.error).toContain("181 seconds");
    expect(acquire).not.toHaveBeenCalled();
  });

  it("turns a phone video held upright the right way up, with no rotation left in the file", async () => {
    const before = probeFile(saved(clips.rotated, "rotated-in.mov")).streams[0]!;
    expect([before.width, before.height]).toEqual([320, 180]);
    expect(JSON.stringify(before.side_data_list)).toContain("rotation");
    const fit = ok(await fitVideo(from(clips.rotated), "video/quicktime", MiB16));
    const after = probeFile(saved(fit.bytes, "rotated-out.mp4")).streams.find((s) => s.codec_type === "video")!;
    expect([after.width, after.height]).toEqual([180, 320]);
    expect(after.side_data_list ?? []).toEqual([]);
  });

  it("refuses a file with no video stream", async () => {
    const fit = await fitVideo(from(clips.audioOnly), "video/mp4", MiB16);
    expect(fit).toEqual({ ok: false, code: "media_invalid", error: "This file has no video in it." });
    expect(acquire).not.toHaveBeenCalled();
  });

  it("makes its temp directory private (0700) and removes it even when the download throws", async () => {
    let mode = 0;
    const fit = await fitVideo(async (dest) => {
      mode = statSync(dirname(dest)).mode & 0o777;
      writeFileSync(dest, clips.hevcMov.subarray(0, 1000));
      throw new Error("staged object read short");
    }, "video/quicktime", MiB16);
    expect(mode).toBe(0o700);
    expect(fit).toMatchObject({ ok: false, code: "media_invalid" });
  });

  it("sweeps a temp directory a killed transcode left behind, on the first video of a process", async () => {
    const crashed = join(work, "wa-video-crashed");
    mkdirSync(crashed);
    writeFileSync(join(crashed, "in"), clips.hevcMov);
    const old = (Date.now() - 20 * 60_000) / 1000;
    utimesSync(crashed, old, old);
    vi.resetModules();
    const fresh = await import("./video-transcode");
    expect((await fresh.fitVideo(from(clips.h264), "video/mp4", MiB16)).ok).toBe(true);
    expect(readdirSync(work)).toEqual([]);
  });

  it("answers 'busy' after 5 s while another transcode holds the one slot, and runs once it is free", async () => {
    const release = (await videoTranscodeSlots.acquire(1))!;
    const t0 = Date.now();
    const busy = await fitVideo(from(clips.hevcMov), "video/quicktime", MiB16);
    expect(busy).toMatchObject({ ok: false, code: "media_busy" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4_900);
    release();
    expect((await fitVideo(from(clips.hevcMov), "video/quicktime", MiB16)).ok).toBe(true);
  }, 30_000);
});

describe.skipIf(!tools)("hostile input", () => {
  let server: Server;
  let hits: string[];
  let port = 0;

  beforeAll(async () => {
    hits = [];
    server = createServer((req, res) => {
      hits.push(req.url ?? "");
      res.end("x");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const hls = () => `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://127.0.0.1:${port}/hls.ts\n#EXTINF:10,\n/etc/passwd\n#EXT-X-ENDLIST\n`;
  const concat = () => `ffconcat version 1.0\nfile '/etc/passwd'\nfile 'http://127.0.0.1:${port}/concat.ts'\n`;

  // Without an MP4 box at the start the file never reaches ffprobe at all.
  const NOT_MP4 = "This file isn't an MP4 or MOV video. Export it as MP4 and try again.";
  const UNREADABLE = "This video couldn't be read. Export it as MP4 and try again.";
  it.each([
    ["an HLS playlist named .mp4", () => Buffer.from(hls()), NOT_MP4],
    ["an ffconcat list named .mp4", () => Buffer.from(concat()), NOT_MP4],
    ["an HLS playlist behind a real ftyp box", () => Buffer.concat([FTYP, Buffer.from(hls())]), UNREADABLE],
    ["an ffconcat list behind a real ftyp box", () => Buffer.concat([FTYP, Buffer.from(concat())]), UNREADABLE],
  ])("refuses %s, fetching nothing and reading no other file", async (_l, bytes, error) => {
    for (const type of ["video/mp4", "video/quicktime"]) {
      const fit = await fitVideo(from(bytes()), type, MiB16);
      expect(fit).toEqual({ ok: false, code: "media_invalid", error });
    }
    expect(hits).toEqual([]);
    expect(acquire).not.toHaveBeenCalled();
  });

  /**
   * Each guard in `guardedInput`, alone, against the attack it exists for —
   * with the forced mov demuxer swapped for a playlist one, as if the sniff
   * and the forcing had both been lost. The unguarded control proves each
   * probe would otherwise succeed.
   */
  const ffprobe = (args: string[]) =>
    run(tools!.ffprobe, ["-v", "error", ...args, "-show_entries", "stream=codec_name", "-of", "csv"], {
      timeoutMs: 10_000,
      maxBuffer: 1 << 20,
    });
  function asConcat(list: string, drop: "-protocol_whitelist" | "-format_whitelist" | "both"): string[] {
    const args = guardedInput(list);
    for (const flag of drop === "both" ? ["-protocol_whitelist", "-format_whitelist"] : [drop]) {
      const at = args.indexOf(flag);
      if (at >= 0) args.splice(at, 2);
    }
    const forced = args.indexOf("-f");
    if (forced >= 0) args.splice(forced, 2);
    args.splice(args.indexOf("-i"), 0, "-f", "concat", "-safe", "0");
    return args;
  }

  it("the format whitelist alone stops a concat list naming another local file", async () => {
    const list = join(clipDir, "local.ffconcat");
    writeFileSync(list, `ffconcat version 1.0\nfile '${saved(clips.h264, "victim.mp4")}'\n`);
    const control = await ffprobe(asConcat(list, "both"));
    expect(control.code).toBe(0);
    expect(control.stdout).toContain("h264");
    const guarded = await ffprobe(asConcat(list, "-protocol_whitelist"));
    expect(guarded.code).not.toBe(0);
    expect(guarded.stderr).toContain("not on whitelist");
    expect(guarded.stdout).not.toContain("h264");
  });

  it("the protocol whitelist alone stops a concat list that opens a data: URL", async () => {
    const segment = join(clipDir, "seg.ts");
    const { execFileSync } = await import("node:child_process");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=1", "-t", "1", "-c:v", "libx264", "-f", "mpegts", segment]);
    const list = join(clipDir, "data.ffconcat");
    writeFileSync(list, `ffconcat version 1.0\nfile 'data:video/mp2t;base64,${readFileSync(segment).toString("base64")}'\n`);
    const control = await ffprobe(asConcat(list, "both"));
    expect(control.code).toBe(0);
    expect(control.stdout).toContain("h264");
    const guarded = await ffprobe(asConcat(list, "-format_whitelist"));
    expect(guarded.code).not.toBe(0);
    expect(guarded.stderr).toContain("Protocol 'data' not on whitelist 'file'");
  });
});

describe("run", () => {
  it("SIGKILLs a process at its timeout", async () => {
    const t0 = Date.now();
    const r = await run("/bin/sleep", ["30"], { timeoutMs: 300, maxBuffer: 1024 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("kills a process that floods stderr past the cap, and does not call it a timeout", async () => {
    const r = await run("/bin/sh", ["-c", "exec /usr/bin/yes >&2"], { timeoutMs: 10_000, maxBuffer: 4096 });
    expect(r.timedOut).toBe(false);
    expect(r.code).not.toBe(0);
    expect(r.stderr.length).toBeLessThanOrEqual(4096);
  });

  it("gives the child an empty environment", async () => {
    process.env.VT_TEST_SECRET = "s3cret";
    const r = await run("/usr/bin/env", [], { timeoutMs: 5_000, maxBuffer: 1 << 16 });
    delete process.env.VT_TEST_SECRET;
    expect(r.stdout).toBe("");
  });
});

describe("detectVideoTools", () => {
  it("finds nothing on an empty PATH", async () => {
    expect(await detectVideoTools({ PATH: "" })).toBeNull();
  });

  it("refuses a configured FFMPEG_PATH that is relative, missing, or not ffmpeg — never falling back to PATH", async () => {
    const env = (FFMPEG_PATH: string) => ({ PATH: process.env.PATH, FFMPEG_PATH });
    expect(await detectVideoTools(env("ffmpeg"))).toBeNull();
    expect(await detectVideoTools(env("/nonexistent/ffmpeg"))).toBeNull();
    expect(await detectVideoTools(env("/bin/echo"))).toBeNull();
  });

  it.skipIf(!tools)("finds a working ffmpeg ≥ 5 with libx264 and aac", async () => {
    expect(await detectVideoTools()).toMatchObject({ ffmpeg: expect.stringMatching(/ffmpeg$/) });
  });
});

/**
 * A stand-in ffmpeg that passes detection, then runs `job` (sh) for any real
 * encode, with `$out` set to the output path it was given.
 */
async function withStubFfmpeg<T>(job: string, body: (fresh: typeof import("./video-transcode")) => Promise<T>): Promise<T> {
  const stub = join(base, "ffmpeg-stub");
  writeFileSync(stub, [
    "#!/bin/sh",
    'case "$2" in',
    '  -version) echo "ffmpeg version 6.1.1-stub"; exit 0;;',
    "  -encoders) printf ' V....D libx264   x\\n A....D aac   x\\n'; exit 0;;",
    "esac",
    'for a; do out="$a"; done; out="${out#file:}"',
    job,
    "",
  ].join("\n"));
  chmodSync(stub, 0o755);
  vi.resetModules();
  vi.stubEnv("FFMPEG_PATH", stub);
  try {
    return await body(await import("./video-transcode"));
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
}

describe.skipIf(!tools)("with a stand-in ffmpeg", () => {
  it("SIGKILLs an ffmpeg that overruns the wall-clock budget, refuses the send, and removes the temp directory", async () => {
    const pidFile = join(base, "stub.pid");
    await withStubFfmpeg(`echo $$ > ${pidFile}; exec /bin/sleep 30`, async (fresh) => {
      const t0 = Date.now();
      const fit = await fresh.fitVideo(from(clips.hevcMov), "video/quicktime", MiB16, { budgetMs: 1_500 });
      expect(fit).toEqual({ ok: false, code: "media_invalid", error: "This video took too long to convert. Trim it and try again." });
      expect(Date.now() - t0).toBeLessThan(5_000);
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    });
  }, 20_000);

  it("refuses an encode whose output fails the codec check, rather than sending it", async () => {
    // "Succeeds", but writes an HEVC MP4 small enough to fit.
    const hevc = join(__dirname, "__fixtures__/video/hevc-hvc1-aac.mp4");
    await withStubFfmpeg(`/bin/cp ${hevc} "$out"`, async (fresh) => {
      const fit = await fresh.fitVideo(from(clips.hevcMov), "video/quicktime", MiB16);
      expect(fit).toEqual({ ok: false, code: "media_invalid", error: "This video couldn't be converted for WhatsApp." });
    });
  }, 20_000);
});

describe("mp4Filename", () => {
  it("renames to .mp4 and holds the name to 255 bytes", () => {
    expect(mp4Filename("IMG_0042.MOV")).toBe("IMG_0042.mp4");
    expect(mp4Filename("clip")).toBe("clip.mp4");
    expect(Buffer.byteLength(mp4Filename(`${"é".repeat(200)}.mov`))).toBeLessThanOrEqual(255);
  });
});
