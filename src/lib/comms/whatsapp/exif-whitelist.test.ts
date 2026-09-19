import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { buildExif, FIXTURE_TAKEN, withApp1 } from "@/test/exif-fixture";
import { whitelistExif } from "./exif-whitelist";

describe("whitelistExif", () => {
  it("keeps GPS, capture time and Orientation 1 — nothing else — from a camera-like block read back by sharp", async () => {
    const thumbnail = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#ff00ff" } }).jpeg().toBuffer();
    const base = await sharp({ create: { width: 32, height: 16, channels: 3, background: "#808080" } }).jpeg().toBuffer();
    const { exif } = await sharp(withApp1(base, buildExif({ orientation: 6, thumbnail }))).metadata();
    expect(whitelistExif(exif)).toEqual({
      IFD0: { Orientation: "1", DateTime: FIXTURE_TAKEN },
      IFD2: { DateTimeOriginal: FIXTURE_TAKEN },
      IFD3: {
        GPSLatitudeRef: "S",
        GPSLatitude: "26/1 12/1 0/1",
        GPSLongitudeRef: "E",
        GPSLongitude: "28/1 2/1 0/1",
      },
    });
  });

  it.each([
    ["missing", undefined],
    ["empty", Buffer.alloc(0)],
    ["not TIFF", Buffer.from("Exif\0\0garbage-garbage-garbage")],
    ["truncated mid-IFD", Buffer.concat([Buffer.from("Exif\0\0II*\0\x08\0\0\0\x05\0", "latin1")])],
    ["over 64 KB", Buffer.concat([Buffer.from("Exif\0\0II*\0\x08\0\0\0", "latin1"), Buffer.alloc(200_000)])],
  ])("returns null for a %s block, never throwing", (_l, block) => {
    expect(whitelistExif(block)).toBeNull();
  });

  it("drops a value whose offset points outside the block, rather than reading past it", () => {
    const tiff = buildExif({ orientation: 1, thumbnail: Buffer.alloc(8) });
    // Point IFD0's DateTime (entry 1) at an offset far beyond the block.
    tiff.writeUInt32LE(0x7fff_0000, 8 + 2 + 12 * 1 + 8);
    expect(whitelistExif(Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]))).toBeNull();
  });
});
