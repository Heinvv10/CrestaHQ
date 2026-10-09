import "server-only";

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The form engine's container image (docker/form-engine). Its tag is written
 * by scripts/form-engine-image.mjs into docker/form-engine/dist/TAG at deploy
 * time, and the Next build traces that file — so a release always runs the
 * image built from its own sources. The channel is available only when that
 * image exists and `docker` answers for this user.
 */

const TAG_FILE = "docker/form-engine/dist/TAG";
const TAG = /^leadstack-form-engine:[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{12}$/;
const HEALTH_TTL_MS = 5 * 60_000;

/** The release's image tag, or null when the build did not produce one. */
export async function formEngineImage(cwd = process.cwd()): Promise<string | null> {
  const tag = (await readFile(join(cwd, TAG_FILE), "utf8").catch(() => "")).trim();
  return TAG.test(tag) ? tag : null;
}

/** `docker image inspect <tag>` succeeded within 10 s. */
function imagePresent(tag: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("docker", ["image", "inspect", "--format", "{{.Id}}", tag], { timeout: 10_000 }, (err) => {
      if (err) console.error("[mystery-shop/form] form engine image not available", tag, err.message);
      resolve(!err);
    });
  });
}

let health: { at: number; ok: Promise<boolean> } | null = null;

/** Is the engine's image here and docker usable by this user? Cached for 5 minutes. */
export function formEngineAvailable(now = Date.now()): Promise<boolean> {
  if (health && now - health.at < HEALTH_TTL_MS) return health.ok;
  const ok = formEngineImage().then((tag) => (tag ? imagePresent(tag) : false));
  health = { at: now, ok };
  return ok;
}
