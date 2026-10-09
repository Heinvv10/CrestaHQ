import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The form channel's health: the release's image tag, and `docker image inspect` on it. */

const inspect = vi.fn<(args: string[]) => Error | null>();
vi.mock("node:child_process", () => ({
  execFile: (_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null) => void) => cb(inspect(args)),
}));
const { formEngineAvailable, formEngineImage } = await import("./engine-image");

const TAG = "leadstack-form-engine:1.62.1-0123456789ab";
const release = (tag: string | null) => {
  const dir = mkdtempSync(join(tmpdir(), "lsms-tag-"));
  if (tag !== null) {
    mkdirSync(join(dir, "docker/form-engine/dist"), { recursive: true });
    writeFileSync(join(dir, "docker/form-engine/dist/TAG"), `${tag}\n`);
  }
  return dir;
};

beforeEach(() => {
  inspect.mockReset().mockReturnValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("formEngineImage", () => {
  it("is the release's TAG file, when it is a well-formed tag", async () => {
    expect(await formEngineImage(release(TAG))).toBe(TAG);
    expect(await formEngineImage(release(null))).toBeNull();
    for (const bad of ["", "leadstack-form-engine:latest", "evil/image:1.62.1-0123456789ab", `${TAG}; rm -rf /`]) {
      expect(await formEngineImage(release(bad)), bad).toBeNull();
    }
  });
});

describe("formEngineAvailable", () => {
  it("needs the tag AND docker image inspect to succeed; the answer is cached for 5 minutes", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(release(TAG));
    inspect.mockReturnValue(new Error("No such image"));
    expect(await formEngineAvailable(1_000_000)).toBe(false);
    inspect.mockReturnValue(null);
    expect(await formEngineAvailable(1_000_000 + 60_000)).toBe(false);
    expect(await formEngineAvailable(1_000_000 + 5 * 60_000)).toBe(true);
    expect(inspect).toHaveBeenLastCalledWith(["image", "inspect", "--format", "{{.Id}}", TAG]);
    cwd.mockReturnValue(release(null));
    expect(await formEngineAvailable(1_000_000 + 10 * 60_000 + 1)).toBe(false);
  });
});
