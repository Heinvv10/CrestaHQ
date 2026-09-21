/**
 * A hand-built EXIF block, for tests that need fields sharp's `withExif()`
 * cannot write: an IFD1 thumbnail, a MakerNote and a body serial number,
 * alongside GPS, DateTimeOriginal and an Orientation. Little-endian TIFF.
 */

export const FIXTURE_TAKEN = "2026:09:19 10:11:12";
export const FIXTURE_MAKERNOTE = Buffer.from("MAKERNOTE-SECRET-0xC0FFEE");
export const FIXTURE_SERIAL = "SERIAL-4815162342";

interface Entry {
  tag: number;
  type: number;
  count: number;
  value: Buffer;
}

const ascii = (tag: number, s: string): Entry => ({ tag, type: 2, count: s.length + 1, value: Buffer.from(`${s}\0`, "latin1") });
const short = (tag: number, v: number): Entry => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return { tag, type: 3, count: 1, value: b };
};
const long = (tag: number, v: number): Entry => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return { tag, type: 4, count: 1, value: b };
};
const rationals = (tag: number, vs: number[]): Entry => {
  const b = Buffer.alloc(vs.length * 4);
  vs.forEach((v, i) => b.writeUInt32LE(v, i * 4));
  return { tag, type: 5, count: vs.length / 2, value: b };
};

/** TIFF bytes (no "Exif\0\0" prefix). `thumbnail` goes in IFD1. */
export function buildExif(opts: { orientation: number; thumbnail: Buffer }): Buffer {
  const ifdSize = (n: number) => 2 + 12 * n + 4;
  // Layout: header, IFD0 (4), ExifIFD (3), GPS (4), IFD1 (2), then data.
  const at = { ifd0: 8 } as Record<string, number>;
  at.exif = at.ifd0! + ifdSize(4);
  at.gps = at.exif + ifdSize(3);
  at.ifd1 = at.gps + ifdSize(4);
  let data = at.ifd1 + ifdSize(2);
  const out = Buffer.alloc(4096 + opts.thumbnail.length);
  out.write("II", 0, "latin1");
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(at.ifd0!, 4);

  const writeIfd = (offset: number, entries: Entry[], next: number) => {
    out.writeUInt16LE(entries.length, offset);
    entries.forEach((e, i) => {
      const p = offset + 2 + i * 12;
      out.writeUInt16LE(e.tag, p);
      out.writeUInt16LE(e.type, p + 2);
      out.writeUInt32LE(e.count, p + 4);
      if (e.value.length <= 4) e.value.copy(out, p + 8);
      else {
        out.writeUInt32LE(data, p + 8);
        e.value.copy(out, data);
        data += e.value.length + (e.value.length % 2);
      }
    });
    out.writeUInt32LE(next, offset + 2 + entries.length * 12);
  };

  writeIfd(at.ifd0!, [short(0x0112, opts.orientation), ascii(0x0132, FIXTURE_TAKEN), long(0x8769, at.exif), long(0x8825, at.gps)], at.ifd1);
  writeIfd(
    at.exif,
    [
      ascii(0x9003, FIXTURE_TAKEN),
      { tag: 0x927c, type: 7, count: FIXTURE_MAKERNOTE.length, value: FIXTURE_MAKERNOTE },
      ascii(0xa431, FIXTURE_SERIAL),
    ],
    0,
  );
  writeIfd(
    at.gps,
    [ascii(0x0001, "S"), rationals(0x0002, [26, 1, 12, 1, 0, 1]), ascii(0x0003, "E"), rationals(0x0004, [28, 1, 2, 1, 0, 1])],
    0,
  );
  const thumbAt = data;
  opts.thumbnail.copy(out, thumbAt);
  data += opts.thumbnail.length;
  writeIfd(at.ifd1, [long(0x0201, thumbAt), long(0x0202, opts.thumbnail.length)], 0);
  return out.subarray(0, data);
}

/** `jpeg` with the EXIF block inserted as an APP1 segment right after SOI. */
export function withApp1(jpeg: Buffer, tiff: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)]);
}

/** IFD0's next-IFD offset in an EXIF block: 0 means there is no IFD1 (no thumbnail). */
export function ifd1Offset(exif: Buffer): number {
  const tiff = exif.subarray(0, 6).toString("latin1") === "Exif\0\0" ? exif.subarray(6) : exif;
  const le = tiff.subarray(0, 2).toString("latin1") === "II";
  const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const ifd0 = u32(4);
  return u32(ifd0 + 2 + 12 * u16(ifd0));
}
