#!/usr/bin/env bash
# Regenerates the MP4 fixtures the video codec inspectors are tested against —
# src/lib/comms/whatsapp/video-codec.test.ts and
# services/wa-agent-bridge/internal/videocodec. Both suites read these same
# files; do not copy them.
#
# Each file is 1 second of 64x64 at the lowest quality, so the set stays a few
# KB. Needs ffmpeg with libx264, libx265, aac and libopus, and python3.
set -euo pipefail
cd "$(dirname "$0")"

V=(-f lavfi -i color=c=blue:s=64x64:r=5:d=1)
A=(-f lavfi -i sine=frequency=440:sample_rate=8000:duration=1)
H264=(-c:v libx264 -preset ultrafast -crf 51 -pix_fmt yuv420p)
HEVC=(-c:v libx265 -x265-params log-level=error -preset ultrafast -crf 51 -pix_fmt yuv420p)
AAC=(-c:a aac -b:a 8k -ac 1)
ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }

ff "${V[@]}" "${A[@]}" "${H264[@]}" "${AAC[@]}" -movflags +faststart -shortest h264-aac-faststart.mp4
ff "${V[@]}" "${A[@]}" "${H264[@]}" "${AAC[@]}" -shortest h264-aac-moov-at-end.mp4
ff "${V[@]}" "${H264[@]}" -an h264-no-audio.mp4
ff "${V[@]}" "${A[@]}" "${HEVC[@]}" -tag:v hvc1 "${AAC[@]}" -shortest hevc-hvc1-aac.mp4
ff "${V[@]}" "${A[@]}" "${HEVC[@]}" -tag:v hev1 "${AAC[@]}" -shortest hevc-hev1-aac.mp4
ff "${V[@]}" -f lavfi -i sine=frequency=440:sample_rate=48000:duration=1 "${H264[@]}" \
  -c:a libopus -b:a 6k -ac 1 -shortest h264-opus.mp4

# Decoys: grow the mdat of a moov-at-end file with bytes that spell the OTHER
# codec's sample-entry fourcc, dressed as box headers. mdat precedes moov, so
# appending to it moves no chunk offset. A parser that walks boxes never reads
# mdat; a substring scan finds the decoy and gets the answer backwards.
python3 - <<'PY'
import struct

def with_decoy(src, dst, fourccs):
    d = bytearray(open(src, "rb").read())
    i = 0
    while i < len(d):
        size, kind = struct.unpack(">I4s", d[i:i + 8])
        if kind == b"mdat":
            decoy = b"".join(struct.pack(">I", 8) + f for f in fourccs) + b"stsd" + b" ".join(fourccs)
            d[i + size:i + size] = decoy
            struct.pack_into(">I", d, i, size + len(decoy))
            open(dst, "wb").write(d)
            return
        i += size
    raise SystemExit(f"{src}: no mdat")

with_decoy("h264-aac-moov-at-end.mp4", "h264-with-hevc-bytes-in-mdat.mp4", [b"hvc1", b"hev1"])
with_decoy("hevc-hvc1-aac.mp4", "hevc-with-avc1-bytes-in-mdat.mp4", [b"avc1", b"avc3", b"mp4a"])
PY

# Not an MP4 at all, and an MP4 cut off mid-mdat.
printf 'this is not a video, just text labelled video/mp4\n' > garbage.mp4
head -c 1200 h264-aac-moov-at-end.mp4 > truncated.mp4
