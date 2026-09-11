import type { WaPhotoMime } from "./types";

/** Meta accepts profile photos up to 5 MB. */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/**
 * Decide the type from the bytes' own magic numbers, never the client's
 * content-type. JPEG starts FF D8 FF; PNG starts 89 50 4E 47 0D 0A 1A 0A.
 */
export function sniffPhotoMime(bytes: Uint8Array): WaPhotoMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= png.length && png.every((b, i) => bytes[i] === b)) {
    return "image/png";
  }
  return null;
}
