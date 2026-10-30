import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { jpegFilename, planDecode, shrinkImage, sniffImageType } from "./image-shrink";

// Real sharp, with every `.timeout()` argument recorded, and every decode
// of an encoded image (a render of a non-raw input) counted.
const timeouts = vi.hoisted(() => [] as number[]);
const decodes = vi.hoisted(() => ({ n: 0 }));
vi.mock("sharp", async (importOriginal) => {
  const real = (await importOriginal<{ default: typeof sharp }>()).default;
  const wrapped = (...a: Parameters<typeof real>) => {
    const inst = real(...a);
    const timeout = inst.timeout.bind(inst);
    inst.timeout = (o: { seconds: number }) => {
      timeouts.push(o.seconds);
      return timeout(o);
    };
    const fromRaw = !!(a[1] as { raw?: unknown } | undefined)?.raw;
    const toBuffer = inst.toBuffer.bind(inst) as (...x: unknown[]) => unknown;
    (inst as unknown as { toBuffer: (...x: unknown[]) => unknown }).toBuffer = (...x: unknown[]) => {
      if (!fromRaw && Buffer.isBuffer(a[0])) decodes.n += 1;
      return toBuffer(...x);
    };
    return inst;
  };
  return { default: Object.assign(wrapped, real) };
});

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
    expect(plan).toMatchObject({ ok: true, reserveBytes: Math.ceil((w * h * 3) / factor ** 2) + 60_000_000 + input.length });
  });

  it.each([
    ["4000×3000", 4000, 3000],
    ["5200×3900 (no 1/2 shrink-on-load discount)", 5200, 3900],
  ])("reserves a progressive %s JPEG at its full-size coefficient buffer, 2 bytes a sample, +25%", async (_l, w, h) => {
    const input = await solid(w, h, 3).jpeg({ progressive: true }).toBuffer();
    expect(await planDecode(input, "image/jpeg")).toMatchObject({
      ok: true,
      reserveBytes: Math.ceil(w * h * 3 * 2 * 1.25) + 60_000_000 + input.length,
    });
  });

  it("reserves a WebP at its pixels +25%", async () => {
    const input = await solid(1000, 800, 3).webp().toBuffer();
    expect(await planDecode(input, "image/webp")).toMatchObject({
      ok: true,
      reserveBytes: Math.ceil(1000 * 800 * 3 * 1.25) + 60_000_000 + input.length,
    });
  });

  it("reserves an interlaced (Adam7) PNG at its pixels +25%; a non-interlaced one at its pixels", async () => {
    const png = (progressive: boolean) => solid(1000, 800, 4).toColourspace("rgb16").png({ progressive }).toBuffer();
    const interlaced = await png(true);
    expect((await sharp(interlaced).metadata()).isProgressive).toBe(true);
    expect(await planDecode(interlaced, "image/png")).toMatchObject({
      ok: true,
      reserveBytes: Math.ceil(1000 * 800 * 4 * 2 * 1.25) + 60_000_000 + interlaced.length,
    });
    const plain = await png(false);
    expect(await planDecode(plain, "image/png")).toMatchObject({
      ok: true,
      reserveBytes: 1000 * 800 * 4 * 2 + 60_000_000 + plain.length,
    });
  });

  it("reserves a 16-bit RGBA PNG at 8 bytes a pixel", async () => {
    const input = await solid(1000, 800, 4).toColourspace("rgb16").png().toBuffer();
    expect((await sharp(input).metadata()).depth).toBe("ushort");
    expect(await planDecode(input, "image/png")).toMatchObject({
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

describe("shrinkImage deadline", () => {
  it("never hands sharp a timeout under 1 s — 0 would mean no limit — and stops when the time is gone", async () => {
    // A clock that jumps 1.6 s at every read, and a cap no encode can meet,
    // so the fit loop runs until the deadline.
    const input = await solid(64, 48, 3).jpeg().toBuffer();
    let reads = 0;
    const base = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => base + 1600 * reads++);
    timeouts.length = 0;
    try {
      const r = await shrinkImage(input, "image/jpeg", 1);
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining("took too long") });
    } finally {
      clock.mockRestore();
    }
    expect(timeouts.length).toBeGreaterThan(1);
    expect(Math.min(...timeouts)).toBeGreaterThanOrEqual(1);
  });
});

describe("shrinkImage decodes once", () => {
  it("decodes the original ONCE however many fit steps run — every step encodes from the raw pixels", async () => {
    const input = await solid(3000, 2000, 3).jpeg().toBuffer();
    decodes.n = 0;
    // A 1-byte cap: all 12 quality × size steps run, and none fits.
    const r = await shrinkImage(input, "image/jpeg", 1);
    expect(r).toMatchObject({ ok: false, code: "media_too_large" });
    expect(decodes.n).toBe(1);
  });
});

describe("shrinkImage orientation", () => {
  // Stored 80×40: top-left red, top-right green, bottom-left blue, bottom-right
  // white. Expected displayed corners [TL, TR, BL, BR] per the EXIF spec.
  const R = "r", G = "g", B = "b", W = "w";
  it.each([
    [1, [R, G, B, W], [80, 40]],
    [2, [G, R, W, B], [80, 40]],
    [3, [W, B, G, R], [80, 40]],
    [4, [B, W, R, G], [80, 40]],
    [5, [R, B, G, W], [40, 80]],
    [6, [B, R, W, G], [40, 80]],
    [7, [W, G, B, R], [40, 80]],
    [8, [G, W, R, B], [40, 80]],
  ] as const)("Orientation %i comes out upright with Orientation 1", async (orientation, corners, size) => {
    const px = Buffer.alloc(80 * 40 * 3);
    const colour = { r: [230, 20, 20], g: [20, 230, 20], b: [20, 20, 230], w: [240, 240, 240] };
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 80; x++) {
        const c = colour[y < 20 ? (x < 40 ? "r" : "g") : x < 40 ? "b" : "w"];
        px.set(c, (y * 80 + x) * 3);
      }
    }
    const input = await sharp(px, { raw: { width: 80, height: 40, channels: 3 } })
      .jpeg({ quality: 95 })
      .withMetadata({ orientation })
      .toBuffer();
    const r = await shrinkImage(input, "image/jpeg", 5_000_000);
    if (!r.ok) throw new Error(r.error);
    const meta = await sharp(r.bytes).metadata();
    expect([meta.width, meta.height, meta.orientation]).toEqual([...size, 1]);
    const { data, info } = await sharp(r.bytes).raw().toBuffer({ resolveWithObject: true });
    const name = (x: number, y: number) => {
      const i = (y * info.width + x) * 3;
      const [pr, pg, pb] = [data[i]!, data[i + 1]!, data[i + 2]!];
      if (pr > 200 && pg > 200 && pb > 200) return W;
      return pr > pg && pr > pb ? R : pg > pb ? G : B;
    };
    const [w, h] = [info.width - 4, info.height - 4];
    expect([name(3, 3), name(w, 3), name(3, h), name(w, h)]).toEqual(corners);
  });
});
