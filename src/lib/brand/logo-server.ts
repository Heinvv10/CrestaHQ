import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import sharp from "sharp";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  LOGO_MAX_BYTES,
  LOGO_MAX_EDGE,
  uploadedLogoPath,
  type LogoMime,
  type LogoScope,
} from "@/lib/brand/logo-shared";

/**
 * Uploaded logos live as base64 in server-only docs (both paths are deny-all
 * in the rules) and are served by the public /api/brand/logo route. The
 * existing `logoUrl` field then points at that route, so every consumer keeps
 * working unchanged.
 */

export type { LogoScope };

/** Upload body cap: the base64 ceiling below plus JSON framing. */
export const LOGO_MAX_BODY_BYTES = 600_000;

export function logoDocRef(scope: LogoScope, id: string) {
  const db = getAdminDb();
  return scope === "agency"
    ? db.doc(`agencies/${id}/brandAssets/logo`)
    : db.doc(`subAccounts/${id}/private/brandLogo`);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Total bytes of ancillary (lowercase-first) PNG chunks a logo may carry. */
export const PNG_MAX_ANCILLARY_BYTES = 64 * 1024;

/**
 * Walks the PNG chunk list: IHDR first, at least one IDAT, IEND last and
 * nothing after it, so a PNG header glued onto another file's bytes is
 * refused. Ancillary chunks (text, profiles, anything a decoder may skip)
 * are capped at PNG_MAX_ANCILLARY_BYTES in total. That bounds one place
 * extra bytes can ride; it does not make the file payload-free (see
 * validateLogo). Returns the IHDR dimensions, or null when the structure is
 * broken.
 */
function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 8 || !PNG_SIGNATURE.every((b, i) => buf[i] === b)) return null;
  let off = 8;
  let size: { width: number; height: number } | null = null;
  let sawIdat = false;
  let ancillary = 0;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const end = off + 12 + len;
    if (!/^[A-Za-z]{4}$/.test(type) || end > buf.length) return null;
    if (!size) {
      if (type !== "IHDR" || len !== 13) return null;
      size = { width: buf.readUInt32BE(off + 8), height: buf.readUInt32BE(off + 12) };
    }
    if (type === "IEND") return end === buf.length && sawIdat ? size : null;
    if (type === "IDAT") sawIdat = true;
    if (/^[a-z]/.test(type)) {
      ancillary += 12 + len;
      if (ancillary > PNG_MAX_ANCILLARY_BYTES) return null;
    }
    off = end;
  }
  return null;
}

/** Smallest payload each first chunk needs for the fields read from it. */
const WEBP_MIN_FIRST_CHUNK = new Map([["VP8 ", 10], ["VP8L", 5], ["VP8X", 10]]);

/**
 * RIFF/WEBP container whose RIFF length covers exactly the buffer and whose
 * chunks tile it exactly: every chunk (plus its pad byte) fits, and no byte
 * sits outside a chunk. The canvas size is read from the first chunk (lossy
 * VP8, lossless VP8L, or the extended VP8X a canvas emits for
 * lossy-with-alpha), which must be at least as long as the fields read from
 * it. Null otherwise.
 */
function webpSize(buf: Buffer): { width: number; height: number } | null {
  if (
    buf.length < 20 ||
    buf.toString("ascii", 0, 4) !== "RIFF" ||
    buf.toString("ascii", 8, 12) !== "WEBP" ||
    buf.readUInt32LE(4) !== buf.length - 8
  ) {
    return null;
  }
  for (let off = 12; off < buf.length; ) {
    if (off + 8 > buf.length) return null;
    const size = buf.readUInt32LE(off + 4);
    const end = off + 8 + size + (size & 1);
    if (end > buf.length) return null;
    off = end;
  }
  const chunk = buf.toString("ascii", 12, 16);
  const min = WEBP_MIN_FIRST_CHUNK.get(chunk);
  if (min === undefined || buf.readUInt32LE(16) < min) return null;
  if (chunk === "VP8 ") {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
}

/**
 * The synchronous half of validateLogo: base64, size, container structure
 * and the stated dimensions, with no decode. Returns the buffer or a problem
 * string.
 */
export function checkLogoStructure(base64: unknown, mime: unknown): Buffer | string {
  if (mime !== "image/png" && mime !== "image/webp") {
    return "Logo must be a PNG or WebP";
  }
  if (typeof base64 !== "string" || base64.length === 0) {
    return "Missing logo data";
  }
  if (base64.length > LOGO_MAX_BYTES * 1.4) {
    return "Logo is too large. Try a simpler image.";
  }
  if (base64.length % 4 !== 0 || !BASE64_RE.test(base64)) {
    return "Logo data isn't valid base64";
  }
  const buf = Buffer.from(base64, "base64");
  if (buf.length === 0 || buf.length > LOGO_MAX_BYTES) {
    return "Logo is too large. Try a simpler image.";
  }
  const size = mime === "image/png" ? pngSize(buf) : webpSize(buf);
  if (!size) {
    return mime === "image/png" ? "Logo data isn't a PNG" : "Logo data isn't a WebP";
  }
  // Small slack over the client resize target.
  if (
    !size.width ||
    !size.height ||
    size.width > LOGO_MAX_EDGE * 2 ||
    size.height > LOGO_MAX_EDGE * 2
  ) {
    return "Logo dimensions are out of range";
  }
  return buf;
}

/**
 * Absolute so the URL works inside emails and PDFs, not just the app.
 * Anchored to NEXT_PUBLIC_APP_URL, never the request origin: under the
 * standalone server that origin is the bind address (localhost), which no
 * email client can reach. Null when the app URL isn't configured.
 */
export function logoPublicUrl(scope: LogoScope, id: string, version: number): string | null {
  const base = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  if (!base || !/^https?:\/\/[^/]+$/i.test(base)) return null;
  return `${base}${uploadedLogoPath(scope, id)}?v=${version}`;
}

export async function storeLogo(
  scope: LogoScope,
  id: string,
  buf: Buffer,
  mime: LogoMime,
): Promise<number> {
  const version = Date.now();
  await logoDocRef(scope, id).set({
    data: buf.toString("base64"),
    mime,
    bytes: buf.length,
    version,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return version;
}

/** Decoder pixel ceiling: the structural edge cap squared, so it never refuses a file that passed. */
const LOGO_MAX_PIXELS = 1024 * 1024;
const LOGO_DECODE_TIMEOUT_S = 5;

/**
 * Upload validation: checkLogoStructure, then a full decode with sharp
 * (pixel ceiling, fail on any decoder error, time-bounded), which must
 * report the claimed format and the structurally stated dimensions.
 *
 * What a stored logo is guaranteed to be: a PNG or WebP of the declared mime
 * that libvips decodes completely, at most 1024 px on each edge and 400 KB,
 * whose decode is bounded in pixels and time (a zlib stream longer than the
 * image is not inflated past its last row). What it is NOT guaranteed to be:
 * free of bytes a decoder ignores. Data past the last row in IDAT, PNG
 * ancillary chunks (64 KB in total), and WebP chunks libwebp skips are all
 * still possible. The serve route's safety rests on the stored mime,
 * `nosniff` and the sandboxing CSP, not on the bytes being pure.
 */
export async function validateLogo(base64: unknown, mime: unknown): Promise<Buffer | string> {
  const buf = checkLogoStructure(base64, mime);
  if (typeof buf === "string") return buf;
  const size = mime === "image/png" ? pngSize(buf) : webpSize(buf);
  const format = mime === "image/png" ? "png" : "webp";
  const refused = `Logo data doesn't decode as a ${mime === "image/png" ? "PNG" : "WebP"} image`;
  try {
    const image = sharp(buf, { limitInputPixels: LOGO_MAX_PIXELS, failOn: "error" }).timeout({
      seconds: LOGO_DECODE_TIMEOUT_S,
    });
    const meta = await image.metadata();
    if (meta.format !== format || meta.width !== size?.width || meta.height !== size?.height) return refused;
    // Every pixel, not just the header: a broken bitstream fails here.
    await image.raw().toBuffer();
  } catch (err) {
    // A decoder refusal is the answer, not a fault.
    console.warn("[brand/logo] decode refused:", err instanceof Error ? err.message : String(err));
    return refused;
  }
  return buf;
}

