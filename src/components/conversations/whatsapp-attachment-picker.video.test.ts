// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WhatsappAttachmentState } from "./whatsapp-attachment-picker";

/**
 * The picker on a host that converts videos (ffmpeg on the server), and on
 * one whose answer never arrives. The answer is cached per page load, so each
 * test imports the module afresh.
 */

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }));

let mints: Array<{ contentType: string; sizeBytes: number }>;
let capability: () => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

function installFetch() {
  mints = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init === undefined) return capability();
    if (url === "/api/comms/whatsapp/upload-url") {
      mints.push(JSON.parse(init.body as string));
      return { ok: true, status: 200, json: async () => ({ stagedId: "s1", uploadUrl: "https://storage.test/put", contentLengthRange: "0,1" }) };
    }
    return { ok: true, status: 200 };
  });
}

let root: Root;
let latest: WhatsappAttachmentState | null = null;

async function mount() {
  const { useWhatsappAttachment } = await import("./whatsapp-attachment-picker");
  function Probe() {
    latest = useWhatsappAttachment("cloud", "c1", "c1:whatsapp");
    return null;
  }
  await act(async () => root.render(createElement(Probe)));
  await settle();
}

const settle = () => act(async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
});

async function pick(file: File) {
  await act(async () => latest!.pick(file));
  await settle();
}

function sized(size: number, name: string, type: string): File {
  const file = new File([new Uint8Array([0])], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  capability = async () => ({ ok: true, status: 200, json: async () => ({ videoTranscode: true }) });
  installFetch();
  toastError.mockReset();
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("where the server converts: admits a 200 MB iPhone .mov and asks for a URL for it", async () => {
  await mount();
  expect(latest!.videoTranscode).toBe(true);
  await pick(sized(200_000_000, "IMG_0042.MOV", "video/quicktime"));
  expect(toastError).not.toHaveBeenCalled();
  expect(mints).toEqual([{ contactId: "c1", contentType: "video/quicktime", sizeBytes: 200_000_000 }]);
});

it("where the server converts: refuses a video over 250 MB before asking", async () => {
  await mount();
  await pick(sized(250_000_001, "long.mp4", "video/mp4"));
  expect(mints).toEqual([]);
  expect(toastError).toHaveBeenCalledWith(expect.stringContaining("the limit for a video is"));
});

it("where the server converts: does not refuse an HEVC MP4 in the browser — the server converts it", async () => {
  await mount();
  const bytes = readFileSync(join(__dirname, "../../lib/comms/whatsapp/__fixtures__/video/hevc-hvc1-aac.mp4"));
  const file = new File([new Uint8Array(bytes)], "clip.mp4", { type: "video/mp4" });
  await pick(file);
  expect(toastError).not.toHaveBeenCalled();
  expect(mints).toHaveLength(1);
});

it("when the answer fails: offers only what every host takes — a .mov is refused in the browser", async () => {
  capability = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await mount();
  expect(latest!.videoTranscode).toBe(false);
  await pick(sized(1_000_000, "IMG_0042.MOV", "video/quicktime"));
  expect(mints).toEqual([]);
  expect(toastError).toHaveBeenCalledWith("IMG_0042.MOV: this file type cannot be sent on WhatsApp here.");
});
