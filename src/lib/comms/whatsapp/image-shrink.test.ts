import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { jpegFilename, planDecode, sniffImageType } from "./image-shrink";

/**
 * The decode reservation is read from the photo's header, so it tracks what
 * the decode will really hold: pixels × channels × bytes per sample, at
 * JPEG's shrink-on-load scale, plus 60 MB working memory and the input copy.
 */

const solid = (width: number, height: number, channels: 3 | 4) =>
  sharp({ create: { width, height, channels, background: { r: 90, g: 120, b: 150, alpha: 0.5 } } });

describe("planDecode", () => {
  it.each([
    ["a 4000×3000 JPEG, decoded at full scale", 4000, 3000, 1],
    ["a 5200×3900 JPEG, decoded at 1/2 scale", 5200, 3900, 2],
    ["a 10400×7800 JPEG, decoded at 1/4 scale", 10_400, 7_800, 4],
  ])("reserves %s by its pixels", async (_l, w, h, factor) => {
    const input = await solid(w, h, 3).jpeg().toBuffer();
    const plan = await planDecode(input, "image/jpeg");
    expect(plan).toEqual({ ok: true, reserveBytes: Math.ceil((w * h * 3) / factor ** 2) + 60_000_000 + input.length });
  });

  it("reserves a 16-bit RGBA PNG at 8 bytes a pixel", async () => {
    const input = await solid(1000, 800, 4).toColourspace("rgb16").png().toBuffer();
    expect((await sharp(input).metadata()).depth).toBe("ushort");
    expect(await planDecode(input, "image/png")).toEqual({
      ok: true,
      reserveBytes: 1000 * 800 * 4 * 2 + 60_000_000 + input.length,
    });
  });

  it("refuses a photo whose reservation exceeds the whole decode budget, before any decode", async () => {
    // 45 MP 16-bit RGBA: under the 50 MP limit, but 360 MB of pixels.
    const input = await solid(7500, 6000, 4).toColourspace("rgb16").png({ compressionLevel: 9 }).toBuffer();
    expect(await planDecode(input, "image/png")).toMatchObject({ ok: false, code: "media_too_large" });
  });

  it("refuses bytes whose decoded format disagrees with the sniffed type", async () => {
    const png = await solid(10, 10, 3).png().toBuffer();
    expect(await planDecode(png, "image/jpeg")).toMatchObject({ ok: false, code: "media_invalid" });
  });
});

describe("sniffImageType", () => {
  it("recognises only JPEG, PNG and WebP by their magic bytes", async () => {
    const px = solid(8, 8, 3);
    expect(sniffImageType(await px.clone().jpeg().toBuffer())).toBe("image/jpeg");
    expect(sniffImageType(await px.clone().png().toBuffer())).toBe("image/png");
    expect(sniffImageType(await px.clone().webp().toBuffer())).toBe("image/webp");
    expect(sniffImageType(await px.clone().gif().toBuffer())).toBeNull();
    expect(sniffImageType(await px.clone().tiff().toBuffer())).toBeNull();
    expect(sniffImageType(await px.clone().avif().toBuffer())).toBeNull();
    expect(sniffImageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImageType(Buffer.from("RIFF\0\0\0\0WAVE"))).toBeNull();
  });
});

describe("jpegFilename", () => {
  it.each([
    ["IMG_1234.PNG", "IMG_1234.jpg"],
    ["photo.webp", "photo.jpg"],
    ["noext", "noext.jpg"],
    ["x".repeat(253), `${"x".repeat(251)}.jpg`],
  ])("%s → %s", (name, want) => {
    expect(jpegFilename(name)).toBe(want);
  });
});
