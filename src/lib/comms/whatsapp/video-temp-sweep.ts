import "server-only";

import { lstat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The prefix of every transcode's temp directory (video-transcode.ts). Its
 * `finally` removes the directory, but a SIGKILL, an OOM kill or a crash
 * during a transcode skips that and leaves up to ~500 MB behind. Nothing else
 * cleans /tmp here, so the first transcode in each process sweeps what
 * earlier processes left.
 */
export const VIDEO_TEMP_PREFIX = "wa-video-";

/** A live transcode lasts under a minute (its budget is 40 s), so anything this old was abandoned. */
const STALE_MS = 10 * 60_000;

/**
 * Remove the `wa-video-*` directories in `dir` last modified more than
 * STALE_MS ago. Only real directories with that prefix are touched, never a
 * symlink or a file. Best effort: never throws, and logs what it could not do.
 */
export async function sweepStaleVideoTemp(now = Date.now(), dir = tmpdir()): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    console.warn("[whatsapp/video-temp-sweep] cannot list", dir, err instanceof Error ? err.message : typeof err);
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(VIDEO_TEMP_PREFIX)) continue;
    const path = join(dir, name);
    try {
      const st = await lstat(path);
      if (!st.isDirectory() || now - st.mtimeMs <= STALE_MS) continue;
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      console.warn("[whatsapp/video-temp-sweep] cannot remove", path, err instanceof Error ? err.message : typeof err);
    }
  }
  if (removed > 0) console.warn(`[whatsapp/video-temp-sweep] removed ${removed} abandoned transcode dir(s) from ${dir}`);
  return removed;
}

let swept: Promise<number> | null = null;

/** The sweep, once per process. */
export function sweepStaleVideoTempOnce(): Promise<number> {
  swept ??= sweepStaleVideoTemp();
  return swept;
}
