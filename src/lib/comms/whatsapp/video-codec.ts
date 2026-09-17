/**
 * Whether an MP4 carries codecs WhatsApp will actually play.
 *
 * WhatsApp needs H.264 video and AAC audio. A file that breaks that rule is
 * not refused at upload: Meta accepts it, returns a wamid, and the delivery
 * fails asynchronously while the thread row says "sent". The common case is an
 * iPhone's HEVC `.mp4`, which passes every MIME check there is. So the codecs
 * are read out of the file BEFORE anything is uploaded.
 *
 * They are read by walking the ISO-BMFF box tree
 * (moov → trak → mdia → hdlr / minf → stbl → stsd), never by searching the
 * bytes for "hvc1" or "avc1": those four bytes turn up inside compressed media
 * in `mdat` often enough to give the wrong answer either way.
 *
 * services/wa-agent-bridge/internal/videocodec is the Go mirror of this rule,
 * for the bridge's non-CRM callers. Both are tested against the same fixtures
 * in __fixtures__/video/.
 */

export type VideoCodecCheck =
  | { ok: true }
  | {
      ok: false;
      /** `video_codec_unsupported` for a readable file with the wrong codecs;
       *  `media_invalid` for one that is not a readable MP4 at all. */
      code: "video_codec_unsupported" | "media_invalid";
      message: string;
    };

const H264 = new Set(["avc1", "avc3"]);
const HEVC = new Set(["hvc1", "hev1"]);
const AAC = "mp4a";

/** More boxes than any real file has; reaching it means a hostile or broken one. */
const MAX_BOXES = 10_000;

const EXPORT_HINT = "Export it as H.264 MP4 and try again.";
const UNREADABLE: VideoCodecCheck = {
  ok: false,
  code: "media_invalid",
  message: `This video couldn't be read as an MP4. ${EXPORT_HINT}`,
};

class Unreadable extends Error {}

interface Box {
  type: string;
  /** Payload bounds, header excluded. */
  start: number;
  end: number;
}

/** A fourcc safe to show an operator: printable ASCII, else hex. */
function fourcc(bytes: Uint8Array, at: number): string {
  const b = bytes.subarray(at, at + 4);
  return b.every((c) => c >= 0x20 && c < 0x7f)
    ? String.fromCharCode(...b)
    : [...b].map((c) => c.toString(16).padStart(2, "0")).join("");
}

export function checkWhatsappVideoCodecs(bytes: Uint8Array): VideoCodecCheck {
  try {
    return check(bytes);
  } catch (err) {
    if (err instanceof Unreadable) return UNREADABLE;
    throw err;
  }
}

function check(bytes: Uint8Array): VideoCodecCheck {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let budget = MAX_BOXES;

  /** The child boxes of [start, end). Any size that does not fit is unreadable. */
  function children(start: number, end: number): Box[] {
    const out: Box[] = [];
    let at = start;
    while (at < end) {
      if (--budget < 0 || end - at < 8) throw new Unreadable();
      let size = view.getUint32(at);
      const type = fourcc(bytes, at + 4);
      let header = 8;
      if (size === 1) {
        if (end - at < 16) throw new Unreadable();
        const large = view.getBigUint64(at + 8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new Unreadable();
        size = Number(large);
        header = 16;
      } else if (size === 0) {
        size = end - at; // extends to the end of its parent
      }
      if (size < header || size > end - at) throw new Unreadable();
      out.push({ type, start: at + header, end: at + size });
      at += size;
    }
    return out;
  }

  function only(boxes: Box[], type: string): Box {
    const found = boxes.filter((b) => b.type === type);
    if (found.length !== 1) throw new Unreadable();
    return found[0]!;
  }

  const top = children(0, bytes.length);
  const moov = only(top, "moov");
  // A file cut off exactly where its media begins still has a well-formed
  // moov, and nothing to play.
  if (!top.some((b) => b.type === "mdat" && b.end > b.start)) throw new Unreadable();
  const videoEntries: string[][] = [];
  const audioEntries: string[] = [];

  for (const trak of children(moov.start, moov.end).filter((b) => b.type === "trak")) {
    const mdia = only(children(trak.start, trak.end), "mdia");
    const mdiaKids = children(mdia.start, mdia.end);
    const hdlr = only(mdiaKids, "hdlr");
    // version/flags (4) + pre_defined (4) + handler_type (4)
    if (hdlr.end - hdlr.start < 12) throw new Unreadable();
    const handler = fourcc(bytes, hdlr.start + 8);
    // Timecode, metadata and hint tracks (an iPhone writes some) are not
    // what WhatsApp plays, so they are not what this judges.
    if (handler !== "vide" && handler !== "soun") continue;

    const minf = only(mdiaKids, "minf");
    const stbl = only(children(minf.start, minf.end), "stbl");
    const stsd = only(children(stbl.start, stbl.end), "stsd");
    // version/flags (4) + entry_count (4), then the sample entries as boxes.
    if (stsd.end - stsd.start < 8) throw new Unreadable();
    const count = view.getUint32(stsd.start + 4);
    const entries = children(stsd.start + 8, stsd.end).map((b) => b.type);
    if (count === 0 || entries.length !== count) throw new Unreadable();

    if (handler === "vide") videoEntries.push(entries);
    else audioEntries.push(...entries);
  }

  if (videoEntries.length === 0) {
    return refuse(`This file has no video WhatsApp can play. ${EXPORT_HINT}`);
  }
  if (videoEntries.length > 1) {
    return refuse(`This video has more than one video track, which WhatsApp can't play. ${EXPORT_HINT}`);
  }
  for (const entry of videoEntries[0]!) {
    if (HEVC.has(entry)) {
      return refuse(`This video is HEVC (H.265), which WhatsApp can't play. ${EXPORT_HINT}`);
    }
    if (!H264.has(entry)) {
      return refuse(`This video uses the "${entry.trim()}" codec, which WhatsApp can't play. ${EXPORT_HINT}`);
    }
  }
  for (const entry of audioEntries) {
    if (entry !== AAC) {
      return refuse(
        `This video's sound is "${entry.trim()}", which WhatsApp can't play. Export it with AAC audio and try again.`,
      );
    }
  }
  return { ok: true };
}

function refuse(message: string): VideoCodecCheck {
  return { ok: false, code: "video_codec_unsupported", message };
}
