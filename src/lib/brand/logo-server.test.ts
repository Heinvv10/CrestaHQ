import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => ({}) }));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: { serverTimestamp: () => "ts" } }));

import { PNG_MAX_ANCILLARY_BYTES, logoPublicUrl, validateLogo } from "./logo-server";
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

/** One PNG chunk (CRC zeroed: the validator checks structure, not CRCs). */
function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, data, Buffer.alloc(4)]);
}

/** `png` without its ancillary chunks (the encoder adds pHYs), so the cap boundary is exact. */
function criticalOnly(buf: Buffer): Buffer {
  const out = [buf.subarray(0, 8)];
  for (let off = 8; off < buf.length; ) {
    const end = off + 12 + buf.readUInt32BE(off);
    if (/^[A-Z]/.test(buf.toString("latin1", off + 4, off + 5))) out.push(buf.subarray(off, end));
    off = end;
  }
  return Buffer.concat(out);
}

/** The critical-only `png` with `chunk` spliced in right after IHDR (8-byte signature + 25-byte IHDR). */
const afterIhdr = (chunk: Buffer) => {
  const bare = criticalOnly(png);
  return Buffer.concat([bare.subarray(0, 33), chunk, bare.subarray(33)]);
};

describe("validateLogo — PNG chunk content", () => {
  it("accepts the encoder's PNG with its ancillary chunks stripped", () => {
    expect(Buffer.isBuffer(validateLogo(b64(criticalOnly(png)), "image/png"))).toBe(true);
  });

  it("refuses a PNG with no IDAT (header and end only)", () => {
    const empty = Buffer.concat([png.subarray(0, 33), pngChunk("IEND", Buffer.alloc(0))]);
    expect(validateLogo(b64(empty), "image/png")).toBe("Logo data isn't a PNG");
  });

  it("refuses an IDAT that only appears after IEND", () => {
    const idat = pngChunk("IDAT", Buffer.alloc(4));
    const late = Buffer.concat([png.subarray(0, 33), pngChunk("IEND", Buffer.alloc(0)), idat]);
    expect(validateLogo(b64(late), "image/png")).toBe("Logo data isn't a PNG");
  });

  it("accepts small ancillary chunks and refuses them past the cap in total", () => {
    const text = (n: number) => pngChunk("tEXt", Buffer.alloc(n, 0x41));
    expect(Buffer.isBuffer(validateLogo(b64(afterIhdr(text(1024))), "image/png"))).toBe(true);
    // Exactly at the cap is fine; one byte over is not.
    expect(Buffer.isBuffer(validateLogo(b64(afterIhdr(text(PNG_MAX_ANCILLARY_BYTES - 12))), "image/png"))).toBe(true);
    expect(validateLogo(b64(afterIhdr(text(PNG_MAX_ANCILLARY_BYTES - 11))), "image/png")).toBe("Logo data isn't a PNG");
    // Split across several chunks, the total still counts.
    const parts = Buffer.concat(Array.from({ length: 3 }, () => text(PNG_MAX_ANCILLARY_BYTES / 2)));
    expect(validateLogo(b64(afterIhdr(parts)), "image/png")).toBe("Logo data isn't a PNG");
  });

  it("does not count critical chunks against the ancillary cap", () => {
    const idat = pngChunk("IDAT", Buffer.alloc(PNG_MAX_ANCILLARY_BYTES * 2));
    expect(Buffer.isBuffer(validateLogo(b64(afterIhdr(idat)), "image/png"))).toBe(true);
  });
});

/** A RIFF/WEBP container around raw chunks (`fourcc`, payload), padded like RIFF. */
function riff(chunks: Array<[string, Buffer]>, trailing = Buffer.alloc(0)): Buffer {
  const body = Buffer.concat([
    ...chunks.map(([fourcc, payload]) => {
      const head = Buffer.alloc(8);
      head.write(fourcc, 0, "ascii");
      head.writeUInt32LE(payload.length, 4);
      return Buffer.concat([head, payload, Buffer.alloc(payload.length & 1)]);
    }),
    trailing,
  ]);
  const head = Buffer.from("RIFF\0\0\0\0WEBP", "latin1");
  head.writeUInt32LE(body.length + 4, 4);
  return Buffer.concat([head, body]);
}

describe("validateLogo — WebP chunk structure", () => {
  it("accepts a real WebP re-wrapped by the test helper (the helper is sound)", async () => {
    const real = await image("webp", { alpha: true });
    const chunks: Array<[string, Buffer]> = [];
    for (let off = 12; off < real.length; ) {
      const size = real.readUInt32LE(off + 4);
      chunks.push([real.toString("ascii", off, off + 4), real.subarray(off + 8, off + 8 + size)]);
      off += 8 + size + (size & 1);
    }
    expect(riff(chunks).equals(real)).toBe(true);
  });

  it("refuses a chunk whose size runs past the container", async () => {
    const webp = Buffer.from(await image("webp"));
    webp.writeUInt32LE(webp.length, 16); // the VP8 chunk now claims more than the file
    expect(validateLogo(b64(webp), "image/webp")).toBe("Logo data isn't a WebP");
  });

  it("refuses bytes inside the RIFF length that are not a chunk", async () => {
    const webp = await image("webp");
    const chunks: Array<[string, Buffer]> = [["VP8 ", webp.subarray(20, 20 + webp.readUInt32LE(16))]];
    expect(Buffer.isBuffer(validateLogo(b64(riff(chunks)), "image/webp"))).toBe(true);
    expect(validateLogo(b64(riff(chunks, Buffer.from("<s>"))), "image/webp")).toBe("Logo data isn't a WebP");
  });

  it("refuses a first chunk too short for the bitstream fields read from it", () => {
    // A 4-byte "VP8 " chunk; the start code and a small size sit in the NEXT
    // chunk's header, where a reader that ignores the chunk length would find them.
    const forged = riff([
      ["VP8 ", Buffer.from([0, 0, 0, 0x9d])],
      [Buffer.from([0x01, 0x2a, 16, 0]).toString("latin1"), Buffer.alloc(16)],
    ]);
    expect(forged.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))).toBe(true);
    expect(validateLogo(b64(forged), "image/webp")).toBe("Logo data isn't a WebP");
  });

  it.each([
    ["VP8L", Buffer.from([0x2f, 0, 0, 0])],
    ["VP8X", Buffer.alloc(9)],
  ])("refuses a %s first chunk under its minimum", (fourcc, payload) => {
    expect(validateLogo(b64(riff([[fourcc, payload], ["ICCP", Buffer.alloc(16)]])), "image/webp")).toBe(
      "Logo data isn't a WebP",
    );
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
