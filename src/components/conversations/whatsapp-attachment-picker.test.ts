// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  useWhatsappAttachment,
  type WhatsappAttachmentState,
} from "./whatsapp-attachment-picker";

/**
 * The hook, directly — not through a composer, whose own channel guard would
 * mask a regression here.
 *
 * `state.key === resetKey ? state : null` is the only thing hiding the old
 * key's file during the render that carries a NEW key: the clearing effect has
 * not run yet. A caller that changes the key from inside an effect (the inbox
 * composer switching to email) reads the hook in exactly that render.
 */

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }));

class FakeReader {
  static reads: FakeReader[] = [];
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  file: File | null = null;
  readAsDataURL(file: File) {
    this.file = file;
    FakeReader.reads.push(this);
  }
  finish(dataBase64 = "AAEC") {
    this.result = `data:${this.file!.type};base64,${dataBase64}`;
    this.onload?.();
  }
}

let root: Root;
let latest: WhatsappAttachmentState | null = null;
/** Every value of `attachment` observed, tagged with the key it was read under. */
let seen: Array<{ phase: "render" | "layout"; key: string; filename: string | null }>;

function Probe({ resetKey }: { resetKey: string }) {
  const wa = useWhatsappAttachment("cloud", resetKey);
  latest = wa;
  seen.push({ phase: "render", key: resetKey, filename: wa.attachment?.filename ?? null });
  useLayoutEffect(() => {
    seen.push({ phase: "layout", key: resetKey, filename: wa.attachment?.filename ?? null });
  });
  return null;
}

const render = (resetKey: string) =>
  act(async () => root.render(createElement(Probe, { resetKey })));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("FileReader", FakeReader);
  FakeReader.reads = [];
  toastError.mockReset();
  seen = [];
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("never exposes the old key's file under a new key, in render or layout effect", async () => {
  await render("c1:whatsapp");
  await act(async () =>
    latest!.pick(new File([new Uint8Array([1])], "site.png", { type: "image/png" })),
  );
  await act(async () => FakeReader.reads[0]!.finish());
  expect(latest!.attachment?.filename).toBe("site.png");

  seen = [];
  await render("c1:email");
  const underNewKey = seen.filter((s) => s.key === "c1:email");
  expect(underNewKey.length).toBeGreaterThan(0);
  expect(underNewKey.every((s) => s.filename === null)).toBe(true);

  // And it stays gone on the way back.
  await render("c1:whatsapp");
  expect(latest!.attachment).toBeNull();
});

function videoBase64(name: string): string {
  return readFileSync(
    join(__dirname, "../../lib/comms/whatsapp/__fixtures__/video", name),
  ).toString("base64");
}

it("drops an HEVC video at pick time and says why; keeps an H.264 one", async () => {
  await render("c1:whatsapp");
  const clip = () => new File([new Uint8Array([1])], "clip.mp4", { type: "video/mp4" });

  await act(async () => latest!.pick(clip()));
  await act(async () => FakeReader.reads[0]!.finish(videoBase64("hevc-hvc1-aac.mp4")));
  expect(latest!.attachment).toBeNull();
  expect(latest!.reading).toBe(false);
  expect(toastError).toHaveBeenCalledWith(expect.stringContaining("HEVC (H.265)"));

  toastError.mockReset();
  const h264 = videoBase64("h264-aac-faststart.mp4");
  await act(async () => latest!.pick(clip()));
  await act(async () => FakeReader.reads[1]!.finish(h264));
  expect(latest!.attachment).toEqual({ filename: "clip.mp4", contentType: "video/mp4", dataBase64: h264 });
  expect(toastError).not.toHaveBeenCalled();
});
