import "server-only";

import sharp from "sharp";

import { IMAGE_DECODE_BUDGET_BYTES, imageDecodeBudget, imageDecodeSlots } from "./media-budget";
import { SHRINKABLE_IMAGE_TYPES, type WhatsAppProviderCapabilities } from "./provider";

/**
 * Fit a composer photo to the rail's image cap by re-encoding it here, so an
 * operator can attach an ordinary phone photo (typically 3–12 MB) on a rail
 * whose cap is 5 MB (Cloud) or 8 MiB (bridge).
 *
 * A photo that already fits, in a type the rail sends, goes out byte for
 * byte — no recompression. Anything else is decoded once, turned upright
 * from its EXIF orientation, flattened onto white (JPEG has no alpha, and a
 * transparent PNG left to the encoder turns black), shrunk to at most
 * MAX_EDGE on its longest side and encoded as JPEG, stepping quality and
 * then dimensions down until it fits.
 *
 * The re-encoded file carries NO metadata: the encoder starts from raw
 * pixels, so a phone photo's EXIF — GPS position included — cannot survive
 * into it. That is a POPIA win for every photo this shrinks; a photo sent
 * unchanged keeps whatever metadata it had.
 *
 * FORMAT. The staged type is only what the uploader signed for, and sharp
 * decodes by sniffing the bytes — prebuilt sharp also renders SVG (librsvg:
 * a 4 KB filter chain costs gigabytes and minutes of CPU), TIFF, GIF and
 * HEIF/AVIF. So every photo's magic bytes are checked (`sniffImageType`)
 * before anything else touches it, including one sent unchanged.
 */

export type PhotoType = "image/jpeg" | "image/png" | "image/webp";

/** The photo type these bytes actually are, or null for anything else. */
export function sniffImageType(head: Uint8Array): PhotoType | null {
  const at = (i: number, bytes: number[]) => bytes.every((b, j) => head[i + j] === b);
  if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  return null;
}

/**
 * Decode limits, and the guard against a decompression bomb. JPEG gets more
 * room because phones shoot 50–108 MP and libjpeg decodes it pre-shrunk (see
 * `jpegShrinkFactor`); PNG and WebP are decoded at full size.
 */
const MAX_PIXELS: Record<PhotoType, number> = {
  "image/jpeg": 110_000_000,
  "image/png": 50_000_000,
  "image/webp": 50_000_000,
};

/** Longest edge of a shrunk photo: sharper than WhatsApp itself shows it. */
const MAX_EDGE = 2560;
const EDGES = [MAX_EDGE, 1920, 1280] as const;
const QUALITIES = [85, 75, 65, 55] as const;

/**
 * The whole job stops within this: every sharp pipeline gets
 * sharp's own timeout of the WHOLE seconds left (never rounded up), and no
 * pipeline starts with under a second left.
 */
const TIMEOUT_MS = 20_000;

/**
 * libvips' per-thread buffers, the ≤2560² raw working copy (~20 MB) and the
 * output. Measured on velo (32 cores), peak RSS over the decoded pixels:
 * ~47 MB for a 108 MP JPEG decoded at 1/4 scale.
 */
const DECODE_OVERHEAD_BYTES = 60_000_000;

/** Headroom on decodes that hold a whole full-size frame at once (below). */
const FULL_FRAME_MARGIN = 1.25;

const BYTES_PER_SAMPLE: Record<string, number> = {
  uchar: 1, char: 1, ushort: 2, short: 2, uint: 4, int: 4, float: 4, complex: 8, double: 8, dpcomplex: 16,
};

/**
 * `pages: 1` — only the first frame of an animated WebP is decoded; the
 * rest would multiply the pixel count past what was reserved.
 * `failOn: "error"` — phone JPEGs commonly carry benign libjpeg warnings
 * (stray bytes before a marker); refusing those ("warning", the default)
 * would refuse ordinary photos, while a real decode error still fails.
 */
function open(input: Uint8Array, type: PhotoType) {
  return sharp(input, { limitInputPixels: MAX_PIXELS[type], pages: 1, failOn: "error" });
}

// libvips caches recent operations, decoded pixels included; in a long-lived
// server that is memory held after the send is over.
sharp.cache(false);

/** Whether this file is a photo the send route must re-encode before sending. */
export function needsShrink(
  caps: WhatsAppProviderCapabilities,
  contentType: string,
  sizeBytes: number,
): boolean {
  if (!SHRINKABLE_IMAGE_TYPES.includes(contentType)) return false;
  return !caps.mediaMimeTypes.includes(contentType) || sizeBytes > caps.maxMediaBytes.image;
}

type Refusal = { ok: false; code: "media_too_large" | "media_invalid" | "media_busy"; error: string };
export type ShrinkResult = { ok: true; bytes: Buffer; contentType: "image/jpeg" } | Refusal;

/**
 * libjpeg decodes at 1/2, 1/4 or 1/8 scale when the target is that much
 * smaller, and sharp uses the largest that still covers MAX_EDGE.
 */
function jpegShrinkFactor(width: number, height: number): number {
  const ratio = Math.max(width, height) / MAX_EDGE;
  return ratio >= 8 ? 8 : ratio >= 4 ? 4 : ratio >= 2 ? 2 : 1;
}

/**
 * Memory a decode of `input` may use, from its header alone (sharp's
 * `metadata()` renders nothing): the decoded pixels — at JPEG's shrink-on-load
 * scale — plus working buffers and the input copy sharp holds.
 */
export async function planDecode(
  input: Buffer,
  type: PhotoType,
): Promise<{ ok: true; reserveBytes: number } | Refusal> {
  let meta: sharp.Metadata;
  try {
    // Headers only, so no pixel limit here — sharp would throw on it before
    // saying why; the limit is checked below, and again by `open` itself.
    meta = await sharp(input, { limitInputPixels: false, pages: 1, failOn: "error" }).metadata();
  } catch (err) {
    console.warn("[whatsapp/image-shrink] header unreadable", err instanceof Error ? err.message : "");
    return unreadable();
  }
  const { width = 0, height = 0, channels = 0, depth = "" } = meta;
  // sharp sniffs too; a disagreement means these are not the bytes checked.
  if (`image/${meta.format}` !== type || !width || !height || !channels || !BYTES_PER_SAMPLE[depth]) {
    return unreadable();
  }
  if (width * height > MAX_PIXELS[type]) {
    return {
      ok: false,
      code: "media_too_large",
      error: `This photo is over ${MAX_PIXELS[type] / 1_000_000} megapixels. Send a smaller photo.`,
    };
  }
  const reserveBytes = decodedBytes(type, meta, width, height, channels, BYTES_PER_SAMPLE[depth]!) +
    DECODE_OVERHEAD_BYTES + input.length;
  if (reserveBytes > IMAGE_DECODE_BUDGET_BYTES) {
    return {
      ok: false,
      code: "media_too_large",
      error: meta.isProgressive
        ? "This is a very large progressive JPEG, which takes too much memory to process. Save it as a standard JPEG, or send a smaller photo."
        : "This photo is too large to process. Send a smaller photo.",
    };
  }
  return { ok: true, reserveBytes };
}

/**
 * What the decoder itself holds, measured per case (PR body):
 *
 * - baseline JPEG: the pixels at libjpeg's shrink-on-load scale.
 * - PROGRESSIVE JPEG: libjpeg keeps the full-size DCT coefficient buffer —
 *   2 bytes per sample, every component at full resolution — for the whole
 *   decode, so no shrink-on-load discount applies. At 12000×9000 that is
 *   ~650–900 MB. Reserved as that buffer plus 25%: at 25 MP CMYK the buffer
 *   alone left only a 5% margin over what was measured. So progressive RGB
 *   files over ~30 MP (CMYK ~23 MP — derived from this formula; review did
 *   not independently re-measure it) are refused. Phones write baseline
 *   JPEGs; progressive ones come from web exports and editors.
 * - WebP: the pixels plus 25%. libwebp decodes the whole frame, and a
 *   rotated 49 MP RGBA WebP measured 273 MB against 275 MB reserved without
 *   it — no margin for a box under load.
 * - PNG: the pixels; plus 25% when interlaced (Adam7, which sharp reports as
 *   `isProgressive`): it decodes the whole frame like WebP, and a rotated
 *   29 MP 16-bit RGBA one used ~310 MB against 294 MB reserved without it.
 */
function decodedBytes(
  type: PhotoType,
  meta: sharp.Metadata,
  width: number,
  height: number,
  channels: number,
  bytesPerSample: number,
): number {
  const full = width * height * channels * bytesPerSample;
  if (type === "image/webp") return Math.ceil(full * FULL_FRAME_MARGIN);
  if (type === "image/png") return meta.isProgressive ? Math.ceil(full * FULL_FRAME_MARGIN) : full;
  if (meta.isProgressive) return Math.ceil(width * height * channels * 2 * FULL_FRAME_MARGIN);
  return Math.ceil(full / jpegShrinkFactor(width, height) ** 2);
}

/**
 * Re-encode `input` — already sniffed as `type` — as a JPEG of at most
 * `capBytes`, holding its decode reservation in the decode budget (separate
 * from the send budget, so a shrink never holds up a document). Never throws.
 */
export async function shrinkImage(input: Buffer, type: PhotoType, capBytes: number): Promise<ShrinkResult> {
  const plan = await planDecode(input, type);
  if (!plan.ok) return plan;
  const releaseSlot = await imageDecodeSlots.acquire(1);
  const releaseBytes = releaseSlot ? await imageDecodeBudget.acquire(plan.reserveBytes) : null;
  try {
    if (!releaseBytes) {
      return { ok: false, code: "media_busy", error: "Other photos are being processed right now. Try again in a minute." };
    }
    return await encodeToFit(input, type, capBytes);
  } finally {
    releaseBytes?.();
    releaseSlot?.();
  }
}

async function encodeToFit(input: Buffer, type: PhotoType, capBytes: number): Promise<ShrinkResult> {
  const deadline = Date.now() + TIMEOUT_MS;
  const seconds = () => Math.floor((deadline - Date.now()) / 1000);
  try {
    const { data, info } = await open(input, type)
      .timeout({ seconds: seconds() })
      .rotate()
      .flatten({ background: "#ffffff" })
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const raw = { width: info.width, height: info.height, channels: info.channels };
    for (const edge of EDGES) {
      for (const quality of QUALITIES) {
        // Read once: a second read could fall to 0, which sharp takes as "no limit".
        const left = seconds();
        if (left < 1) return tookTooLong();
        const out = await sharp(data, { raw })
          .timeout({ seconds: left })
          .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality })
          .toBuffer();
        if (out.length <= capBytes) return { ok: true, bytes: out, contentType: "image/jpeg" };
      }
    }
    return {
      ok: false,
      code: "media_too_large",
      error: `This photo can't be made small enough to send (limit ${capBytes} bytes). Send it as a smaller photo.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("timeout")) return tookTooLong();
    console.warn("[whatsapp/image-shrink] decode failed", message);
    return unreadable();
  }
}

function unreadable(): Refusal {
  return { ok: false, code: "media_invalid", error: "This photo couldn't be read. Attach it again, or send another." };
}

function tookTooLong(): Refusal {
  return { ok: false, code: "media_invalid", error: "This photo took too long to process. Send a smaller photo." };
}

/**
 * `IMG_1234.PNG` → `IMG_1234.jpg`: the name the customer sees must match the
 * JPEG they get. Held to the same 255 bytes the send route checks the
 * original against (the bridge refuses longer), cutting whole code points.
 */
export function jpegFilename(filename: string): string {
  let base = [...filename.replace(/\.[^./\\]*$/, "")];
  while (base.length > 0 && Buffer.byteLength(`${base.join("")}.jpg`, "utf8") > 255) base = base.slice(0, -1);
  return `${base.join("")}.jpg`;
}
