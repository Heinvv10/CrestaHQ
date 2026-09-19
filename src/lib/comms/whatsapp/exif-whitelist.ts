/**
 * The EXIF a shrunk photo keeps — a whitelist, read out of the original's
 * EXIF block, in the shape sharp's `withExif()` writes.
 *
 * Kept, at the business's request (it reaches the customer's phone):
 * - GPS latitude / longitude and their refs: where the photo was taken — the
 *   house the job is at. Altitude and its ref, GPS time and date stamps:
 *   part of the same fix, and the only clock the GPS receiver vouches for.
 * - DateTimeOriginal (when the shutter fired), DateTimeDigitized (the
 *   "CreateDate"), DateTime (last change): when the photo was taken.
 * - Orientation, always 1: the pixels are already turned upright.
 *
 * Everything else is dropped, deliberately. IFD1 carries a thumbnail of the
 * camera's ORIGINAL frame — an operator's crop would still send the uncropped
 * picture. MakerNote, Make/Model and serial numbers identify the device and
 * are not needed.
 *
 * Never throws: a missing, malformed or oversized block yields null, and the
 * photo goes without EXIF rather than not at all.
 */

export type ExifFields = Record<string, Record<string, string>>;

/** A JPEG APP1 segment cannot exceed 64 KB; anything larger is not a camera's EXIF. */
const MAX_EXIF_BYTES = 64 * 1024;
const MAX_IFD_ENTRIES = 512;

const ASCII = 2;
const BYTE = 1;
const RATIONAL = 5;

/** tag → [sharp IFD, sharp name, TIFF type, value count (0 = any)] */
const IFD0_TAGS: Record<number, [string, string, number, number]> = {
  0x0132: ["IFD0", "DateTime", ASCII, 0],
};
const EXIF_TAGS: Record<number, [string, string, number, number]> = {
  0x9003: ["IFD2", "DateTimeOriginal", ASCII, 0],
  0x9004: ["IFD2", "DateTimeDigitized", ASCII, 0],
};
const GPS_TAGS: Record<number, [string, string, number, number]> = {
  0x0001: ["IFD3", "GPSLatitudeRef", ASCII, 0],
  0x0002: ["IFD3", "GPSLatitude", RATIONAL, 3],
  0x0003: ["IFD3", "GPSLongitudeRef", ASCII, 0],
  0x0004: ["IFD3", "GPSLongitude", RATIONAL, 3],
  0x0005: ["IFD3", "GPSAltitudeRef", BYTE, 1],
  0x0006: ["IFD3", "GPSAltitude", RATIONAL, 1],
  0x0007: ["IFD3", "GPSTimeStamp", RATIONAL, 3],
  0x001d: ["IFD3", "GPSDateStamp", ASCII, 0],
};
const EXIF_IFD_POINTER = 0x8769;
const GPS_IFD_POINTER = 0x8825;

export function whitelistExif(exif: Buffer | undefined): ExifFields | null {
  if (!exif || exif.length === 0) return null;
  if (exif.length > MAX_EXIF_BYTES) {
    console.warn("[whatsapp/exif] EXIF block too large; sending without EXIF", { bytes: exif.length });
    return null;
  }
  try {
    return parse(exif);
  } catch (err) {
    console.warn("[whatsapp/exif] EXIF unreadable; sending without EXIF", err instanceof Error ? err.message : "");
    return null;
  }
}

function parse(block: Buffer): ExifFields {
  const tiff = block.subarray(0, 6).toString("latin1") === "Exif\0\0" ? block.subarray(6) : block;
  const order = tiff.subarray(0, 2).toString("latin1");
  if (order !== "II" && order !== "MM") throw new Error("no TIFF byte order");
  const le = order === "II";
  const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  if (u16(2) !== 42) throw new Error("not TIFF");

  const out: ExifFields = { IFD0: { Orientation: "1" } };
  const walk = (offset: number, tags: Record<number, [string, string, number, number]>) => {
    const pointers: Record<number, number> = {};
    const n = u16(offset);
    if (n > MAX_IFD_ENTRIES) throw new Error("IFD too long");
    for (let i = 0; i < n; i++) {
      const e = offset + 2 + i * 12;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      if (tag === EXIF_IFD_POINTER || tag === GPS_IFD_POINTER) pointers[tag] = u32(e + 8);
      const want = tags[tag];
      if (!want || want[2] !== type || (want[3] && want[3] !== count) || count === 0) continue;
      const size = count * (type === RATIONAL ? 8 : 1);
      const at = size <= 4 ? e + 8 : u32(e + 8);
      if (at + size > tiff.length) throw new Error("value out of bounds");
      const value = format(type, count, at);
      if (value !== null) (out[want[0]] ??= {})[want[1]] = value;
    }
    return pointers;
  };
  const format = (type: number, count: number, at: number): string | null => {
    if (type === ASCII) {
      const s = tiff.subarray(at, at + count).toString("latin1").replace(/\0[\s\S]*$/, "");
      return /^[\x20-\x7e]*$/.test(s) && s.length > 0 ? s : null;
    }
    if (type === BYTE) return Array.from(tiff.subarray(at, at + count)).join(" ");
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
      const den = u32(at + i * 8 + 4);
      if (den === 0) return null;
      parts.push(`${u32(at + i * 8)}/${den}`);
    }
    return parts.join(" ");
  };

  const ifd0 = walk(u32(4), IFD0_TAGS);
  if (ifd0[EXIF_IFD_POINTER]) walk(ifd0[EXIF_IFD_POINTER], EXIF_TAGS);
  if (ifd0[GPS_IFD_POINTER]) walk(ifd0[GPS_IFD_POINTER], GPS_TAGS);
  return out;
}
