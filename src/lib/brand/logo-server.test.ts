import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => ({}) }));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: { serverTimestamp: () => "ts" } }));

import { logoPublicUrl, validateLogo } from "./logo-server";
import { LOGO_MAX_BYTES } from "./logo-shared";

const b64 = (buf: Buffer) => buf.toString("base64");

/** Real encoder output, so the parser is checked against what a codec writes. */
async function image(
  format: "png" | "webp",
  { width = 64, height = 32, alpha = false, lossless = false } = {},
): Promise<Buffer> {
  const img = sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: alpha ? { r: 10, g: 20, b: 30, alpha: 0.5 } : { r: 10, g: 20, b: 30 },
    },
  });
  return format === "png" ? img.png().toBuffer() : img.webp({ lossless, quality: 90 }).toBuffer();
}

let png: Buffer;
beforeAll(async () => {
  png = await image("png");
});

describe("validateLogo — accepts what a canvas produces", () => {
  it("accepts a PNG", () => {
    const out = validateLogo(b64(png), "image/png");
    expect(Buffer.isBuffer(out) && out.equals(png)).toBe(true);
  });

  it.each([
    ["lossy (VP8)", { lossless: false }],
    ["lossless (VP8L)", { lossless: true }],
    ["lossy with alpha (VP8X)", { alpha: true }],
  ])("accepts a %s WebP", async (_label, opts) => {
    const webp = await image("webp", opts);
    expect(Buffer.isBuffer(validateLogo(b64(webp), "image/webp"))).toBe(true);
  });
});

describe("validateLogo — refuses anything that is not a PNG/WebP", () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
  const html = Buffer.from("<!doctype html><script>alert(1)</script>");

  it("refuses an SVG, whatever mime it claims", () => {
    expect(validateLogo(b64(svg), "image/svg+xml")).toBe("Logo must be a PNG or WebP");
    expect(validateLogo(b64(svg), "image/png")).toBe("Logo data isn't a PNG");
    expect(validateLogo(b64(svg), "image/webp")).toBe("Logo data isn't a WebP");
  });

  it("refuses HTML, whatever mime it claims", () => {
    expect(validateLogo(b64(html), "text/html")).toBe("Logo must be a PNG or WebP");
    expect(validateLogo(b64(html), "image/png")).toBe("Logo data isn't a PNG");
  });

  it("refuses a PNG with another file glued on after IEND (polyglot)", () => {
    expect(validateLogo(b64(Buffer.concat([png, html])), "image/png")).toBe("Logo data isn't a PNG");
  });

  it("refuses a bare PNG signature with HTML where the chunks should be", () => {
    const fake = Buffer.concat([png.subarray(0, 8), html]);
    expect(validateLogo(b64(fake), "image/png")).toBe("Logo data isn't a PNG");
  });

  it("refuses a PNG whose first chunk is not IHDR", () => {
    const swapped = Buffer.from(png);
    swapped.write("tEXt", 12, "latin1");
    expect(validateLogo(b64(swapped), "image/png")).toBe("Logo data isn't a PNG");
  });

  it("refuses a PNG cut off before IEND", () => {
    expect(validateLogo(b64(png.subarray(0, png.length - 12)), "image/png")).toBe("Logo data isn't a PNG");
  });

  it("refuses a PNG truncated inside its IHDR chunk (without throwing)", () => {
    expect(validateLogo(b64(png.subarray(0, 20)), "image/png")).toBe("Logo data isn't a PNG");
  });

  it.each([
    ["lossy VP8 frame start code", { lossless: false }, 23],
    ["lossless VP8L signature", { lossless: true }, 20],
  ])("refuses a WebP container whose %s is wrong", async (_label, opts, at) => {
    const webp = Buffer.from(await image("webp", opts));
    webp[at] = 0x3c;
    expect(validateLogo(b64(webp), "image/webp")).toBe("Logo data isn't a WebP");
  });

  it("refuses a WebP container whose first chunk is not an image chunk", async () => {
    const webp = Buffer.from(await image("webp"));
    webp.write("ALPH", 12, "ascii");
    expect(validateLogo(b64(webp), "image/webp")).toBe("Logo data isn't a WebP");
  });

  it("refuses a WebP with bytes after the RIFF length (polyglot)", async () => {
    const webp = await image("webp");
    expect(validateLogo(b64(Buffer.concat([webp, html])), "image/webp")).toBe("Logo data isn't a WebP");
  });

  it("refuses a real image declared as the other type", async () => {
    const webp = await image("webp");
    expect(validateLogo(b64(png), "image/webp")).toBe("Logo data isn't a WebP");
    expect(validateLogo(b64(webp), "image/png")).toBe("Logo data isn't a PNG");
  });

  it("refuses data that is not strict base64", () => {
    expect(validateLogo(`${b64(png)}<`, "image/png")).toBe("Logo data isn't valid base64");
    expect(validateLogo(b64(png).replace(/=+$/, "").slice(0, -1), "image/png")).toBe(
      "Logo data isn't valid base64",
    );
  });

  it("refuses missing data", () => {
    expect(validateLogo("", "image/png")).toBe("Missing logo data");
    expect(validateLogo(undefined, "image/png")).toBe("Missing logo data");
  });
});

describe("validateLogo — size and dimension caps", () => {
  it("refuses base64 over the character ceiling before scanning or decoding it", () => {
    // Not even valid base64: only the up-front length check can answer "too large".
    expect(validateLogo("<".repeat(Math.ceil(LOGO_MAX_BYTES * 1.4) + 4), "image/png")).toBe(
      "Logo is too large. Try a simpler image.",
    );
  });

  it("refuses decoded bytes over LOGO_MAX_BYTES", () => {
    const big = Buffer.concat([png, Buffer.alloc(LOGO_MAX_BYTES)]);
    expect(validateLogo(b64(big), "image/png")).toBe("Logo is too large. Try a simpler image.");
  });

  it("accepts the dimension ceiling and refuses one pixel past it", async () => {
    expect(Buffer.isBuffer(validateLogo(b64(await image("png", { width: 1024, height: 8 })), "image/png"))).toBe(true);
    expect(validateLogo(b64(await image("png", { width: 1025, height: 8 })), "image/png")).toBe(
      "Logo dimensions are out of range",
    );
    expect(validateLogo(b64(await image("png", { width: 8, height: 1025 })), "image/png")).toBe(
      "Logo dimensions are out of range",
    );
  });

  it.each([
    ["lossy", { lossless: false }],
    ["lossless", { lossless: true }],
    ["alpha", { alpha: true }],
  ])("refuses an oversize %s WebP", async (_label, opts) => {
    const ok = await image("webp", { ...opts, width: 1024, height: 8 });
    const wide = await image("webp", { ...opts, width: 1025, height: 8 });
    const tall = await image("webp", { ...opts, width: 8, height: 1025 });
    expect(Buffer.isBuffer(validateLogo(b64(ok), "image/webp"))).toBe(true);
    expect(validateLogo(b64(wide), "image/webp")).toBe("Logo dimensions are out of range");
    expect(validateLogo(b64(tall), "image/webp")).toBe("Logo dimensions are out of range");
  });
});

describe("logoPublicUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is anchored to NEXT_PUBLIC_APP_URL", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.example.com/");
    expect(logoPublicUrl("sa", "sa1", 42)).toBe("https://crm.example.com/api/brand/logo/sa/sa1?v=42");
  });

  it("is null without a usable app URL (never the request origin)", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(logoPublicUrl("agency", "ag1", 1)).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "crm.example.com");
    expect(logoPublicUrl("agency", "ag1", 1)).toBeNull();
  });
});
