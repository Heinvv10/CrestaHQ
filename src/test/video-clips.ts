import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Small real clips for the video transcode tests, made with the host's
 * ffmpeg at test time — nothing binary is committed. Each is a second or two
 * at thumbnail size, so the whole set takes a few seconds to make.
 */

export const LOCATION = "-26.2041+028.0473/";
export const CREATED = "2026-09-19T10:11:12.000000Z";

function ffmpeg(args: string[]) {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
}

const src = (size: string, seconds: number, rate = 25) => [
  "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${rate}`,
  "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
  "-t", String(seconds),
];

export interface Clips {
  /** H.264 + AAC MP4, 320×240, ~2 s: already what WhatsApp plays. */
  h264: Buffer;
  /** iPhone-like HEVC `.mov` (hvc1) with location, capture time, and metadata that must NOT survive. */
  hevcMov: Buffer;
  /** H.264 at 4 Mbps, 640×480, 4 s (~2 MB): over any small test cap. */
  h264Big: Buffer;
  /** 181 s — one over the limit — at 64×64, 1 fps, no audio. */
  long: Buffer;
  /** A 320×180 frame with a 90° display rotation, as a phone held upright writes it. */
  rotated: Buffer;
  /** AAC audio in an MP4 container, no video stream. */
  audioOnly: Buffer;
  /** The HEVC `.mov` with its location ONLY as the key an iPhone writes (`com.apple.quicktime.location.ISO6709`). */
  appleLocMov: Buffer;
}

export function makeClips(dir: string): Clips {
  const p = (n: string) => join(dir, n);
  ffmpeg([...src("320x240", 2), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2",
    "-movflags", "+faststart", p("h264.mp4")]);
  ffmpeg([...src("320x240", 2), "-c:v", "libx265", "-x265-params", "log-level=error", "-tag:v", "hvc1",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2",
    "-metadata", `location=${LOCATION}`, "-metadata", `creation_time=${CREATED}`,
    "-metadata", "comment=SECRET-COMMENT", "-metadata", "artist=SECRET-ARTIST",
    "-metadata:s:v:0", "handler_name=SECRET-HANDLER", p("hevc.mov")]);
  ffmpeg([...src("640x480", 4), "-c:v", "libx264", "-b:v", "4M", "-pix_fmt", "yuv420p", "-c:a", "aac", p("big.mp4")]);
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=64x64:rate=1", "-t", "181", "-c:v", "libx264", "-pix_fmt", "yuv420p", p("long.mov")]);
  ffmpeg([...src("320x180", 1), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", p("flat.mp4")]);
  ffmpeg(["-display_rotation", "90", "-i", p("flat.mp4"), "-c", "copy", p("rotated.mov")]);
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "2", "-c:a", "aac", "-f", "mp4", p("audio.mp4")]);
  ffmpeg(["-i", p("hevc.mov"), "-map_metadata", "-1", "-c", "copy", "-movflags", "use_metadata_tags",
    "-metadata", `com.apple.quicktime.location.ISO6709=${LOCATION}`, p("apple.mov")]);
  const r = (n: string) => readFileSync(p(n));
  return {
    h264: r("h264.mp4"),
    hevcMov: r("hevc.mov"),
    h264Big: r("big.mp4"),
    long: r("long.mov"),
    rotated: r("rotated.mov"),
    audioOnly: r("audio.mp4"),
    appleLocMov: r("apple.mov"),
  };
}

export interface ProbedClip {
  streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; side_data_list?: unknown[] }>;
  format: { tags?: Record<string, string> };
}

/** ffprobe's view of a file on disk. */
export function probeFile(path: string): ProbedClip {
  return JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path], { encoding: "utf8" }),
  ) as ProbedClip;
}

/** A 16-byte `ftyp` box: enough to pass a first-box sniff, followed by anything. */
export const FTYP = Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]);
