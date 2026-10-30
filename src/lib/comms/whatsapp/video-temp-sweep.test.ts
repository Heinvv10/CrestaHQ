import { lutimesSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { sweepStaleVideoTemp } from "./video-temp-sweep";

let dir: string;
const OLD = (Date.now() - 20 * 60_000) / 1000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vt-sweep-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function aged(path: string) {
  utimesSync(path, OLD, OLD);
  return path;
}

it("removes only stale wa-video-* directories: never a fresh one, another prefix, a file, or a symlink", async () => {
  const victim = join(dir, "victim");
  mkdirSync(victim);
  writeFileSync(join(victim, "keep"), "x");
  mkdirSync(join(dir, "wa-video-crashed"));
  writeFileSync(join(dir, "wa-video-crashed", "in"), "leftover");
  aged(join(dir, "wa-video-crashed"));
  mkdirSync(join(dir, "wa-video-live"));
  mkdirSync(join(dir, "other-old"));
  aged(join(dir, "other-old"));
  writeFileSync(join(dir, "wa-video-file"), "x");
  aged(join(dir, "wa-video-file"));
  // An old link to a directory: following it would delete what it points at.
  symlinkSync(victim, join(dir, "wa-video-link"));
  lutimesSync(join(dir, "wa-video-link"), OLD, OLD);
  aged(victim);

  expect(await sweepStaleVideoTemp(Date.now(), dir)).toBe(1);
  expect(readdirSync(dir).sort()).toEqual(["other-old", "victim", "wa-video-file", "wa-video-link", "wa-video-live"]);
  expect(readdirSync(victim)).toEqual(["keep"]);
});

it("does not throw when the directory cannot be listed", async () => {
  expect(await sweepStaleVideoTemp(Date.now(), join(dir, "missing"))).toBe(0);
});
