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

/** Storage PUTs that finish only when a test says so. */
let puts: Array<{ url: string; init: RequestInit; finish: (ok?: boolean) => void }>;
let fetchMock: ReturnType<typeof vi.fn>;

function installFetch() {
  let issued = 0;
  puts = [];
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    if (url === "/api/comms/whatsapp/upload-url") {
      issued += 1;
      const n = issued;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          stagedId: `staged${n}`,
          uploadUrl: `https://storage.test/put/${n}`,
          contentLengthRange: "0,5000000",
        }),
      };
    }
    return new Promise((resolve) =>
      puts.push({ url, init, finish: (ok = true) => resolve({ ok, status: ok ? 200 : 403 }) }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
}

let root: Root;
let latest: WhatsappAttachmentState | null = null;
/** Every value of `attachment` observed, tagged with the key it was read under. */
let seen: Array<{ phase: "render" | "layout"; key: string; filename: string | null }>;

function Probe({ contactId, resetKey }: { contactId: string; resetKey: string }) {
  const wa = useWhatsappAttachment("cloud", contactId, resetKey);
  latest = wa;
  seen.push({ phase: "render", key: resetKey, filename: wa.attachment?.filename ?? null });
  useLayoutEffect(() => {
    seen.push({ phase: "layout", key: resetKey, filename: wa.attachment?.filename ?? null });
  });
  return null;
}

const render = (resetKey: string, contactId = resetKey.split(":")[0]!) =>
  act(async () => root.render(createElement(Probe, { contactId, resetKey })));

/** Lets the hook's async upload chain reach its next await. */
const settle = () => act(async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
});

async function pick(file: File) {
  await act(async () => latest!.pick(file));
  await settle();
}

async function finishPut(i: number, ok = true) {
  await act(async () => puts[i]!.finish(ok));
  await settle();
}

const png = (name = "site.png") => new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  installFetch();
  toastError.mockReset();
  seen = [];
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("asks for a URL with the declared type and size, then PUTs the raw file with both signed headers", async () => {
  await render("c1:whatsapp");
  const file = png();
  await pick(file);

  expect(fetchMock.mock.calls[0]![0]).toBe("/api/comms/whatsapp/upload-url");
  expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({
    contactId: "c1",
    contentType: "image/png",
    sizeBytes: 3,
  });
  expect(puts).toHaveLength(1);
  expect(puts[0]!.url).toBe("https://storage.test/put/1");
  expect(puts[0]!.init.method).toBe("PUT");
  // Both are in the URL's signature; Storage refuses a PUT missing either.
  expect(puts[0]!.init.headers).toEqual({
    "content-type": "image/png",
    "x-goog-content-length-range": "0,5000000",
  });
  // The File itself — no FileReader, no base64.
  expect(puts[0]!.init.body).toBe(file);

  expect(latest!.uploading).toBe(true);
  expect(latest!.attachment).toBeNull();
  await finishPut(0);
  expect(latest!.uploading).toBe(false);
  expect(latest!.attachment).toEqual({ stagedId: "staged1", filename: "site.png", contentType: "image/png" });
});

it("drops the file and says so when the PUT is refused", async () => {
  await render("c1:whatsapp");
  await pick(png());
  await finishPut(0, false);
  expect(latest!.attachment).toBeNull();
  expect(latest!.uploading).toBe(false);
  expect(toastError).toHaveBeenCalledWith("Couldn't upload site.png.");
});

it("shows the route's own words when no URL is issued, and never PUTs", async () => {
  fetchMock.mockImplementationOnce(async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: "Attachment is 6000000 bytes; the limit for a image is 5000000." }),
  }));
  await render("c1:whatsapp");
  await pick(png());
  expect(puts).toHaveLength(0);
  expect(latest!.attachment).toBeNull();
  expect(toastError).toHaveBeenCalledWith(expect.stringContaining("the limit for a image"));
});

it("never PUTs when the route issues no size range to send with it", async () => {
  fetchMock.mockImplementationOnce(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ stagedId: "s", uploadUrl: "https://storage.test/put/x" }),
  }));
  await render("c1:whatsapp");
  await pick(png());
  expect(puts).toHaveLength(0);
  expect(latest!.attachment).toBeNull();
  expect(toastError).toHaveBeenCalledWith("Couldn't upload site.png.");
});

it("discards an upload that finishes after a switch to another contact, even on switching back", async () => {
  await render("c1:whatsapp");
  await pick(png());
  await render("c2:whatsapp");
  await finishPut(0);
  expect(latest!.attachment).toBeNull();
  expect(latest!.uploading).toBe(false);
  await render("c1:whatsapp");
  expect(latest!.attachment).toBeNull();
  expect(toastError).not.toHaveBeenCalled();
});

it("keeps the LATER pick when an earlier upload finishes last", async () => {
  await render("c1:whatsapp");
  await pick(png("first.png"));
  await pick(png("second.png"));
  await finishPut(1);
  await finishPut(0);
  expect(latest!.attachment).toMatchObject({ stagedId: "staged2", filename: "second.png" });
});

it("never exposes the old key's file under a new key, in render or layout effect", async () => {
  await render("c1:whatsapp");
  await pick(png());
  await finishPut(0);
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

function videoFile(name: string): File {
  const bytes = readFileSync(join(__dirname, "../../lib/comms/whatsapp/__fixtures__/video", name));
  const file = new File([new Uint8Array(bytes)], "clip.mp4", { type: "video/mp4" });
  // jsdom's File has no arrayBuffer(); every browser the composer runs in does.
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
  return file;
}

it("drops an HEVC video at pick time and says why, before asking for a URL; uploads an H.264 one", async () => {
  await render("c1:whatsapp");

  await pick(videoFile("hevc-hvc1-aac.mp4"));
  expect(latest!.attachment).toBeNull();
  expect(latest!.uploading).toBe(false);
  expect(toastError).toHaveBeenCalledWith(expect.stringContaining("HEVC (H.265)"));
  expect(fetchMock).not.toHaveBeenCalled();

  toastError.mockReset();
  await pick(videoFile("h264-aac-faststart.mp4"));
  await finishPut(0);
  expect(latest!.attachment).toEqual({ stagedId: "staged1", filename: "clip.mp4", contentType: "video/mp4" });
  expect(toastError).not.toHaveBeenCalled();
});
