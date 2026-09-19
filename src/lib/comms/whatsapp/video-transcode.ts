import "server-only";

import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { videoTranscodeSlots } from "./media-budget";
import { checkWhatsappVideoCodecs } from "./video-codec";
import { sweepStaleVideoTempOnce, VIDEO_TEMP_PREFIX } from "./video-temp-sweep";
import { PROBE_TIMEOUT_MS, run, videoTools, type VideoTools } from "./video-tools";

/**
 * Fit a composer video to the rail by transcoding it to H.264/AAC MP4 with
 * ffmpeg, so an operator can attach an ordinary phone video — an iPhone's
 * HEVC `.mov`, or anything over the rail's 16 MiB (Cloud) / 8 MiB (bridge) —
 * instead of having it refused.
 *
 * ONLY WHERE FFMPEG IS — `videoTranscodeAvailable` in video-tools.ts. Without
 * it (Vercel, most dev machines) nothing here runs, and uploads keep the
 * rail's own video cap and codec refusal.
 *
 * A video already H.264/AAC MP4 and within the cap goes out byte for byte.
 * Anything else is probed (over MAX_DURATION_SEC, or with no video stream,
 * is refused before any encode), transcoded once at a bitrate computed to fit
 * — and, if it overshoots, once more at 85% — and must then pass the same
 * `checkWhatsappVideoCodecs` every sent video does.
 *
 * UNTRUSTED INPUT. ffmpeg's demuxers are a large attack surface, so: no shell
 * (execFile, args array); an empty environment; the file's first box sniffed
 * and the mov demuxer FORCED, with every other demuxer refused by
 * `-format_whitelist` (no HLS, concat or other playlist can be opened) and
 * every protocol but `file` by `-protocol_whitelist`; `-nostdin`; `nice`;
 * a hard wall-clock budget ending in SIGKILL; a capped stderr; one transcode
 * at a time. The file lives in a private mkdtemp directory removed on every
 * path (and swept by the next process if this one is killed mid-transcode —
 * video-temp-sweep.ts), and never in this process's memory until the ≤cap result is read.
 *
 * METADATA, as for photos (image-shrink.ts), because the business uses it
 * for maintenance: capture time (`creation_time`) and location are KEPT;
 * everything else is dropped (`-map_metadata -1`, then those two written
 * back). Location is written twice, as ffmpeg's MP4 muxer can: the
 * `com.apple.quicktime.location.ISO6709` key an iPhone writes (via
 * `use_metadata_tags`), and 3GPP `loci` (from `location`). Android's `©xyz`
 * atom is written only by the QuickTime muxer, which would make the file a
 * `.mov`; both values are read from either source by ffprobe.
 */

/** 3 minutes: at 16 MiB that is ~590 kbps (480p), at 8 MiB ~250 kbps (360p). */
export const MAX_DURATION_SEC = 180;
/** 8K. A larger frame is a decode-memory hazard, not a phone video. */
const MAX_PIXELS = 7680 * 4320;
/**
 * Every encode of one send stops within this. Measured on velo at load ~20:
 * 8.7 s for a 37 s 4K60 HEVC clip (the worst the 250 MB upload cap admits),
 * 7.6 s for 180 s of 1080p. The rest of Cloudflare's ~100 s goes to reading
 * the staged file and uploading the result.
 */
const TRANSCODE_BUDGET_MS = 40_000;
const STDERR_CAP_BYTES = 64 << 10;
/** A short clip gains nothing from more; WhatsApp recompresses it anyway. */
const MAX_VIDEO_BPS = 4_000_000;
/** Below this nothing is watchable. Real caps never get here: 8 MiB over 180 s is ~250 kbps. */
const MIN_VIDEO_BPS = 100_000;

/** The mov/mp4 demuxer's registered name — the only demuxer ffmpeg may open. */
const MOV_DEMUXER = "mov,mp4,m4a,3gp,3g2,mj2";
export const PROTOCOL_GUARD: readonly string[] = ["-protocol_whitelist", "file"];
export const FORMAT_GUARD: readonly string[] = ["-format_whitelist", MOV_DEMUXER];
/** Boxes an MP4/MOV/3GP file can start with; old QuickTime files skip `ftyp`. */
const FIRST_BOXES = new Set(["ftyp", "moov", "mdat", "wide", "free", "skip"]);

type Refusal = { ok: false; code: "media_invalid" | "media_too_large" | "media_busy"; error: string };
export type VideoFit = { ok: true; bytes: Buffer; transcoded: boolean } | Refusal;

/** The input half of every ffprobe/ffmpeg call: guards, then the forced demuxer. */
export function guardedInput(path: string): string[] {
  // Forcing `-f mov` is defence in depth behind FORMAT_GUARD, which already leaves only the mov demuxer.
  return [...PROTOCOL_GUARD, ...FORMAT_GUARD, "-f", "mov", "-i", `file:${path}`];
}

interface Probe {
  durationSec: number;
  video: { width: number; height: number } | null;
  audioChannels: number | null;
  creationTime: string | null;
  location: string | null;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const ISO6709 = /^[+-]\d{1,3}(\.\d+)?[+-]\d{1,3}(\.\d+)?([+-]\d{1,5}(\.\d+)?)?\/?$/;

async function probe(t: VideoTools, input: string, cwd: string): Promise<Probe | null> {
  const r = await run(
    t.ffprobe,
    ["-v", "error", "-hide_banner", ...guardedInput(input), "-show_entries",
      "format=duration:format_tags:stream=codec_type,width,height,channels", "-of", "json"],
    { timeoutMs: PROBE_TIMEOUT_MS, maxBuffer: 1 << 20, cwd },
  );
  if (r.code !== 0) return null;
  type Stream = { codec_type?: string; width?: number; height?: number; channels?: number };
  let parsed: { streams?: Stream[]; format?: { duration?: string; tags?: Record<string, string> } };
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  const v = parsed.streams?.find((s) => s.codec_type === "video");
  const a = parsed.streams?.find((s) => s.codec_type === "audio");
  const tags = parsed.format?.tags ?? {};
  const creationTime = tags.creation_time ?? "";
  const location = tags["com.apple.quicktime.location.ISO6709"] ?? tags.location ?? "";
  return {
    durationSec: Number(parsed.format?.duration),
    video: v?.width && v.height ? { width: v.width, height: v.height } : null,
    audioChannels: a ? (a.channels ?? 2) : null,
    // Both reach ffmpeg's argv (never a shell): only the shapes phones write.
    creationTime: ISO_UTC.test(creationTime) ? creationTime : null,
    location: location.length <= 64 && ISO6709.test(location) ? location : null,
  };
}

function audioBps(p: Pick<Probe, "audioChannels">): number {
  return p.audioChannels === null ? 0 : p.audioChannels >= 2 ? 96_000 : 64_000;
}

/** 92% of the cap over the duration, less the audio: the 8% is container and rate-control slack. */
export function videoBitrate(p: Pick<Probe, "durationSec" | "audioChannels">, capBytes: number): number {
  return Math.min(MAX_VIDEO_BPS, Math.floor((capBytes * 8 * 0.92) / p.durationSec) - audioBps(p));
}

function encodeArgs(p: Probe, input: string, output: string, bps: number): string[] {
  // Shorter edge: 720 normally, lower when the bitrate cannot carry it. Never
  // upscaled, always even. Runs after ffmpeg's autorotate, so a portrait
  // phone video comes out upright with no rotation left in the file.
  const edge = bps < 350_000 ? 360 : bps < 700_000 ? 480 : 720;
  const side = (d: string) => `trunc(min(1,${edge}/min(iw,ih))*${d}/2)*2`;
  const ab = audioBps(p);
  return [
    "-nostdin", "-hide_banner", "-nostats", "-v", "error", "-threads", "8",
    ...guardedInput(input),
    "-map", "0:v:0",
    ...(ab ? ["-map", "0:a:0", "-c:a", "aac", "-b:a", String(ab), "-ac", ab === 96_000 ? "2" : "1"] : ["-an"]),
    "-map_metadata", "-1", "-map_chapters", "-1",
    "-t", String(p.durationSec),
    "-vf", `scale=w='${side("iw")}':h='${side("ih")}'`, "-fpsmax", "30",
    "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "main", "-pix_fmt", "yuv420p",
    "-b:v", String(bps), "-maxrate", String(bps), "-bufsize", String(bps * 2),
    "-threads", "8",
    ...(p.creationTime ? ["-metadata", `creation_time=${p.creationTime}`] : []),
    ...(p.location
      ? ["-metadata", `location=${p.location}`, "-metadata", `com.apple.quicktime.location.ISO6709=${p.location}`]
      : []),
    "-movflags", "+faststart+use_metadata_tags",
    "-f", "mp4", "-y", `file:${output}`,
  ];
}

async function firstBoxIsVideo(path: string): Promise<boolean> {
  const fh = await open(path, "r");
  try {
    const { bytesRead, buffer } = await fh.read(Buffer.alloc(8), 0, 8, 0);
    return bytesRead === 8 && FIRST_BOXES.has(buffer.toString("latin1", 4, 8));
  } finally {
    await fh.close();
  }
}

/**
 * `write` puts the video at the path it is given (the staged download).
 * `contentType` is the staged object's. Never throws.
 */
export async function fitVideo(
  write: (dest: string) => Promise<void>,
  contentType: string,
  capBytes: number,
  opts: { budgetMs?: number } = {},
): Promise<VideoFit> {
  const t = await videoTools();
  if (!t) return refuse("media_invalid", "Videos can't be converted here. Export it as H.264 MP4 and try again.");
  // What a killed process left behind; once per process, never throws.
  await sweepStaleVideoTempOnce();
  let dir: string | null = null;
  try {
    // 0700, and a name no other request can guess or share.
    dir = await mkdtemp(join(tmpdir(), VIDEO_TEMP_PREFIX));
    const input = join(dir, "in");
    try {
      await write(input);
    } catch (err) {
      console.warn("[whatsapp/video-transcode] staged download failed", err instanceof Error ? err.message : typeof err);
      return refuse("media_invalid", "The attachment couldn't be read. Attach the file again.");
    }
    return await fitFile(t, dir, input, contentType, capBytes, opts.budgetMs ?? TRANSCODE_BUDGET_MS);
  } catch (err) {
    console.warn("[whatsapp/video-transcode] failed", err instanceof Error ? err.message : typeof err);
    return unreadable();
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
      console.error("[whatsapp/video-transcode] temp dir not removed", dir, err instanceof Error ? err.message : "");
    });
  }
}

async function fitFile(t: VideoTools, dir: string, input: string, contentType: string, capBytes: number, budgetMs: number): Promise<VideoFit> {
  if (!(await firstBoxIsVideo(input))) {
    return refuse("media_invalid", "This file isn't an MP4 or MOV video. Export it as MP4 and try again.");
  }
  if (contentType === "video/mp4" && (await stat(input)).size <= capBytes) {
    const bytes = await readFile(input);
    if (checkWhatsappVideoCodecs(bytes).ok) return { ok: true, bytes, transcoded: false };
  }
  const p = await probe(t, input, dir);
  if (!p || !(p.durationSec > 0)) return unreadable();
  if (!p.video) return refuse("media_invalid", "This file has no video in it.");
  if (p.durationSec > MAX_DURATION_SEC) {
    return refuse("media_too_large", `This video is ${Math.round(p.durationSec)} seconds long; up to ${MAX_DURATION_SEC} seconds can be sent. Trim it and try again.`);
  }
  if (p.video.width * p.video.height > MAX_PIXELS) return refuse("media_too_large", "This video's resolution is too high to convert.");

  if (videoBitrate(p, capBytes) < MIN_VIDEO_BPS) return cannotFit(capBytes);

  const release = await videoTranscodeSlots.acquire(1);
  if (!release) return refuse("media_busy", "Another video is being converted right now. Try again in a minute.");
  try {
    const deadline = Date.now() + budgetMs;
    const output = join(dir, "out.mp4");
    let bps = videoBitrate(p, capBytes);
    for (let attempt = 0; attempt < 2; attempt++, bps = Math.floor(bps * 0.85)) {
      const left = deadline - Date.now();
      if (left < 1_000) return tookTooLong();
      const r = await run(t.nice, ["-n", "10", t.ffmpeg, ...encodeArgs(p, input, output, bps)], { timeoutMs: left, maxBuffer: STDERR_CAP_BYTES, cwd: dir });
      if (r.timedOut) return tookTooLong();
      if (r.code !== 0) {
        console.warn("[whatsapp/video-transcode] ffmpeg failed", r.code, r.stderr.slice(0, 500));
        return unreadable();
      }
      if ((await stat(output)).size > capBytes) continue;
      const bytes = await readFile(output);
      // What goes out must pass the check every sent video does.
      const check = checkWhatsappVideoCodecs(bytes);
      if (!check.ok) {
        console.error("[whatsapp/video-transcode] output failed the codec check", check.message);
        return refuse("media_invalid", "This video couldn't be converted for WhatsApp.");
      }
      return { ok: true, bytes, transcoded: true };
    }
    return cannotFit(capBytes);
  } finally {
    release();
  }
}

function refuse(code: Refusal["code"], error: string): Refusal {
  return { ok: false, code, error };
}

function unreadable(): Refusal {
  return refuse("media_invalid", "This video couldn't be read. Export it as MP4 and try again.");
}

function cannotFit(capBytes: number): Refusal {
  return refuse("media_too_large", `This video can't be made small enough to send (limit ${capBytes} bytes). Trim it and try again.`);
}

function tookTooLong(): Refusal {
  return refuse("media_invalid", "This video took too long to convert. Trim it and try again.");
}

/** `IMG_0042.MOV` → `IMG_0042.mp4`, held to 255 bytes as `jpegFilename` is. */
export function mp4Filename(filename: string): string {
  let base = [...filename.replace(/\.[^./\\]*$/, "")];
  while (base.length > 0 && Buffer.byteLength(`${base.join("")}.mp4`, "utf8") > 255) base = base.slice(0, -1);
  return `${base.join("")}.mp4`;
}
