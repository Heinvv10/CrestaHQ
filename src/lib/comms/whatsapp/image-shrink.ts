import "server-only";

import sharp from "sharp";

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
 */

/**
 * Decode limit, and the guard against a decompression bomb (a tiny file that
 * decodes to gigapixels). 50 MP admits a 48/50 MP phone's full-resolution
 * mode; anything larger is refused before its pixels are allocated.
 */
export const MAX_INPUT_PIXELS = 50_000_000;

/**
 * Memory the send route reserves for a photo this module will decode, on top
 * of the staged Blob it already holds: one more copy of the file (sharp takes
 * a Buffer) plus the decode itself. Measured (PR body) as peak RSS over
 * baseline for the whole shrink: +61 MB for a 13.7 MB 12 MP JPEG, +60 MB for
 * an 18.5 MB 50 MP JPEG (libjpeg decodes it pre-shrunk), +79 MB for a 50 MP
 * RGBA PNG with an orientation tag and +92 MB for a 50 MP rotated WebP, the
 * worst case. Through the whole send route a 15.9 MB phone JPEG peaked at
 * +108 MB, against the 132 MB this reserves for it with the file itself.
 * A naive 50 MP × 4 bytes would be 200 MB, the whole budget.
 */
export function decodeReserveBytes(sizeBytes: number): number {
  return sizeBytes + 100_000_000;
}

/** Longest edge of a shrunk photo: sharper than WhatsApp itself shows it. */
const MAX_EDGE = 2560;
const EDGES = [MAX_EDGE, 1920, 1280] as const;
const QUALITIES = [85, 75, 65, 55] as const;

/** Whole-job deadline. The decode is the slow part; each encode is ~50 ms. */
const TIMEOUT_MS = 20_000;

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

export type ShrinkResult =
  | { ok: true; bytes: Buffer; contentType: "image/jpeg" }
  | { ok: false; code: "media_too_large" | "media_invalid"; error: string };

/** Re-encode `input` as a JPEG of at most `capBytes`. Never throws. */
export async function shrinkImage(input: Uint8Array, capBytes: number): Promise<ShrinkResult> {
  const deadline = Date.now() + TIMEOUT_MS;
  const seconds = () => Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
  try {
    const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
      .timeout({ seconds: seconds() })
      .rotate()
      .flatten({ background: "#ffffff" })
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const raw = { width: info.width, height: info.height, channels: info.channels };
    for (const edge of EDGES) {
      for (const quality of QUALITIES) {
        if (Date.now() > deadline) return tookTooLong();
        const out = await sharp(data, { raw })
          .timeout({ seconds: seconds() })
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
    if (message.includes("pixel limit")) {
      return {
        ok: false,
        code: "media_too_large",
        error: `This photo is over ${MAX_INPUT_PIXELS / 1_000_000} megapixels. Send a smaller photo.`,
      };
    }
    if (message.includes("timeout")) return tookTooLong();
    console.warn("[whatsapp/image-shrink] decode failed", message);
    return { ok: false, code: "media_invalid", error: "This photo couldn't be read. Attach it again, or send another." };
  }
}

function tookTooLong(): ShrinkResult {
  return { ok: false, code: "media_invalid", error: "This photo took too long to process. Send a smaller photo." };
}

/** `IMG_1234.PNG` → `IMG_1234.jpg`: the name the customer sees must match the JPEG they get. */
export function jpegFilename(filename: string): string {
  return `${filename.replace(/\.[^./\\]*$/, "")}.jpg`;
}
