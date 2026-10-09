import "server-only";

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The form engine's container image (docker/form-engine). Its tag is written
 * by scripts/form-engine-image.mjs into docker/form-engine/dist/TAG at deploy
 * time, and the Next build traces that file — so a release always runs the
 * image built from its own sources. The channel is available only when that
 * image AND the engine's own network (FORM_NETWORK) exist and `docker`
 * answers for this user.
 */

/** The engine's own bridge network: no inter-container traffic, a fixed subnet (scripts/form-engine-image.mjs). */
export const FORM_NETWORK = "leadstack-form";

/** The docker CLI's environment: PATH, HOME and DOCKER_HOST only — never the CRM's secrets. */
export function dockerEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  return {
    PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    ...(env.HOME ? { HOME: env.HOME } : {}),
    ...(env.DOCKER_HOST ? { DOCKER_HOST: env.DOCKER_HOST } : {}),
  };
}

const TAG_FILE = "docker/form-engine/dist/TAG";
const TAG = /^leadstack-form-engine:[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{12}$/;
const HEALTH_TTL_MS = 5 * 60_000;

/** The release's image tag, or null when the build did not produce one. */
export async function formEngineImage(cwd = process.cwd()): Promise<string | null> {
  const tag = (await readFile(join(cwd, TAG_FILE), "utf8").catch(() => "")).trim();
  return TAG.test(tag) ? tag : null;
}

/** `docker <args>` succeeded within 10 s. */
function docker(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("docker", args, { timeout: 10_000, env: dockerEnv() as NodeJS.ProcessEnv }, (err) => {
      if (err) console.error("[mystery-shop/form] form engine not available", args.join(" "), err.message);
      resolve(!err);
    });
  });
}

let health: { at: number; ok: Promise<boolean> } | null = null;

/** Is the engine's image here, its network too, and docker usable by this user? Cached for 5 minutes. */
export function formEngineAvailable(now = Date.now()): Promise<boolean> {
  if (health && now - health.at < HEALTH_TTL_MS) return health.ok;
  const ok = formEngineImage().then(async (tag) =>
    tag !== null &&
    (await docker(["image", "inspect", "--format", "{{.Id}}", tag])) &&
    docker(["network", "inspect", "--format", "{{.Id}}", FORM_NETWORK]),
  );
  health = { at: now, ok };
  return ok;
}
