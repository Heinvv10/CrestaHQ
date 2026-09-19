import "server-only";

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * Whether this host can transcode composer videos (video-transcode.ts): an
 * ffmpeg and ffprobe — `FFMPEG_PATH` / `FFPROBE_PATH`, else found on PATH —
 * that pass a version check, plus `nice`. Decided once per process and
 * cached; the upload-url and send routes both ask this one answer, so the
 * cap a file is uploaded under and what its send then does always agree.
 * Absent (Vercel, most dev machines), videos keep the rail's own cap and
 * the codec refusal, exactly as before transcoding existed.
 */

export interface VideoTools {
  ffmpeg: string;
  ffprobe: string;
  nice: string;
}

export const PROBE_TIMEOUT_MS = 5_000;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Nothing of this process's environment — its secrets — reaches ffmpeg. (Next's typing insists on NODE_ENV.) */
const EMPTY_ENV = {} as NodeJS.ProcessEnv;

/** Never throws. */
export function run(bin: string, args: readonly string[], opts: { timeoutMs: number; maxBuffer: number; cwd?: string }): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      { timeout: opts.timeoutMs, killSignal: "SIGKILL", maxBuffer: opts.maxBuffer, env: EMPTY_ENV, cwd: opts.cwd, encoding: "utf8" },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: unknown; killed?: boolean }) | null;
        resolve({
          code: e ? (typeof e.code === "number" ? e.code : null) : 0,
          stdout,
          stderr,
          // Killed by the timeout, not for overrunning maxBuffer.
          timedOut: !!e?.killed && e.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        });
      },
    );
    child.stdin?.end();
  });
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

type Env = Record<string, string | undefined>;

async function locate(name: string, override: string | undefined, env: Env): Promise<string | null> {
  // A configured path that does not work fails closed; it never falls back.
  if (override) return isAbsolute(override) && (await executable(override)) ? override : null;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir && isAbsolute(dir) && (await executable(join(dir, name)))) return join(dir, name);
  }
  return null;
}

function majorVersion(out: string, name: string): number {
  const m = new RegExp(`^${name} version n?(\\d+)\\.`).exec(out);
  return m ? Number(m[1]) : 0;
}

/** The tools, or null when any is missing or not a usable ffmpeg ≥ 5 with libx264 and aac. */
export async function detectVideoTools(env: Env = process.env): Promise<VideoTools | null> {
  const [ffmpeg, ffprobe, nice] = await Promise.all([
    locate("ffmpeg", env.FFMPEG_PATH, env),
    locate("ffprobe", env.FFPROBE_PATH, env),
    locate("nice", undefined, env),
  ]);
  if (!ffmpeg || !ffprobe || !nice) return null;
  const opts = { timeoutMs: PROBE_TIMEOUT_MS, maxBuffer: 1 << 20 };
  const [mv, pv, enc] = await Promise.all([
    run(ffmpeg, ["-hide_banner", "-version"], opts),
    run(ffprobe, ["-hide_banner", "-version"], opts),
    run(ffmpeg, ["-hide_banner", "-encoders"], opts),
  ]);
  const usable =
    majorVersion(mv.stdout, "ffmpeg") >= 5 &&
    majorVersion(pv.stdout, "ffprobe") >= 5 &&
    /^\s*V\S*\s+libx264\s/m.test(enc.stdout) &&
    /^\s*A\S*\s+aac\s/m.test(enc.stdout);
  return usable ? { ffmpeg, ffprobe, nice } : null;
}

let tools: Promise<VideoTools | null> | null = null;

export function videoTools(): Promise<VideoTools | null> {
  tools ??= detectVideoTools().then((t) => {
    if (!t) console.warn("[whatsapp/video-transcode] ffmpeg/ffprobe not found or unusable: videos keep the rail's cap and codec check");
    return t;
  });
  return tools;
}

/** Whether this host transcodes composer videos. Cached for the process's life. */
export async function videoTranscodeAvailable(): Promise<boolean> {
  return (await videoTools()) !== null;
}
