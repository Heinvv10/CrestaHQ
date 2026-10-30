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
 *
 * KNOWN LIMITS. The rule is the sample-entry fourcc (avc1/avc3 video, mp4a
 * audio) plus, for mp4a, the esds objectTypeIndication (AAC only). It does
 * NOT read the avcC profile, so H.264 High 4:2:2 or High 10 passes and may
 * still not play. It does NOT check that an avc1 entry really holds avcC
 * rather than hvcC, so an HEVC stream deliberately relabelled avc1 passes.
 * A fragmented MP4 with more than MAX_BOXES top-level boxes (one per frame)
 * is refused as unreadable; phones do not produce those.
 * OTI 0x40 means "MPEG-4 Audio", not strictly AAC: a hand-built esds with
 * OTI 0x40 whose DecoderSpecificInfo names a non-AAC audioObjectType (e.g.
 * 34, MP3-on-MP4, or 42, USAC) passes. ffmpeg never writes that; it uses
 * 0x69/0x6B for MP3.
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
const MP4A = "mp4a";
/** esds objectTypeIndication values that are AAC: MPEG-4, then MPEG-2 Main/LC/SSR. */
const AAC_OTI = new Set([0x40, 0x66, 0x67, 0x68]);
/** MPEG-2 and MPEG-1 Layer 3 — MP3 in the same mp4a entry AAC uses. */
const MP3_OTI = new Set([0x69, 0x6b]);

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

  /**
   * The child boxes of [start, end). Any size that does not fit is
   * unreadable — except, at the top level only, fewer than 8 trailing bytes
   * after the last box, which some writers leave as padding.
   */
  function children(start: number, end: number, topLevel = false): Box[] {
    const out: Box[] = [];
    let at = start;
    while (at < end) {
      if (topLevel && end - at < 8) break;
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

  const top = children(0, bytes.length, true);
  const moov = only(top, "moov");
  // A file cut off exactly where its media begins still has a well-formed
  // moov, and nothing to play.
  if (!top.some((b) => b.type === "mdat" && b.end > b.start)) throw new Unreadable();
  const videoEntries: string[][] = [];
  const audioEntries: Box[] = [];

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
    const entries = children(stsd.start + 8, stsd.end);
    if (count === 0 || entries.length !== count) throw new Unreadable();

    if (handler === "vide") videoEntries.push(entries.map((b) => b.type));
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
  // Every audio track, not only the first: WhatsApp may pick any of them.
  for (const entry of audioEntries) {
    if (entry.type !== MP4A) {
      return refuse(audioMessage(`"${entry.type.trim()}"`));
    }
    // mp4a is only the container for an MPEG-4 audio stream; MP3 uses it
    // too. The esds objectTypeIndication is what says AAC.
    const oti = objectTypeIndication(entry);
    if (oti === null) {
      // video_codec_unsupported, not media_invalid: the file itself parsed,
      // and what is missing is proof the sound is AAC. The operator's fix is
      // the same as for any wrong audio — re-export with AAC — and calling
      // the whole file unreadable would send them looking for corruption.
      return refuse("This video's sound couldn't be confirmed as AAC, which is all WhatsApp plays. Export it with AAC audio and try again.");
    }
    if (MP3_OTI.has(oti)) return refuse(audioMessage("MP3"));
    if (!AAC_OTI.has(oti)) {
      return refuse(audioMessage(`not AAC (object type 0x${oti.toString(16).padStart(2, "0")})`));
    }
  }
  return { ok: true };

  /**
   * The objectTypeIndication in an mp4a entry's esds, or null when there is
   * no esds or it cannot be parsed. Never throws on malformed descriptors.
   */
  function objectTypeIndication(mp4a: Box): number | null {
    // SampleEntry (8) + AudioSampleEntry fields (20); QuickTime sound
    // description version 1 adds 16 bytes, version 2 adds 36.
    if (mp4a.end - mp4a.start < 28) return null;
    const version = view.getUint16(mp4a.start + 8);
    const fields = version === 0 ? 28 : version === 1 ? 44 : version === 2 ? 64 : -1;
    if (fields < 0 || mp4a.end - mp4a.start < fields) return null;
    let esds: Box;
    try {
      const kids = children(mp4a.start + fields, mp4a.end);
      if (kids.some((b) => b.type === "esds")) {
        esds = only(kids, "esds");
      } else {
        // QuickTime-style files nest esds inside a `wave` box.
        const wave = only(kids, "wave");
        esds = only(children(wave.start, wave.end), "esds");
      }
    } catch (err) {
      if (err instanceof Unreadable) return null;
      throw err;
    }

    /** One descriptor at `at` within `end`: its tag and payload bounds. */
    function descriptor(at: number, end: number): { tag: number; start: number; end: number } | null {
      if (end - at < 2) return null;
      const tag = bytes[at]!;
      let size = 0;
      let i = at + 1;
      // Expandable size: 1–4 bytes, high bit set means another byte follows.
      for (let n = 0; ; n++) {
        if (n === 4 || i >= end) return null;
        const b = bytes[i++]!;
        size = size * 128 + (b & 0x7f);
        if (!(b & 0x80)) break;
      }
      if (size > end - i) return null;
      return { tag, start: i, end: i + size };
    }

    // FullBox version/flags (4), then ES_Descriptor.
    const es = descriptor(esds.start + 4, esds.end);
    if (!es || es.tag !== 0x03 || es.end - es.start < 3) return null;
    const flags = bytes[es.start + 2]!;
    let at = es.start + 3; // ES_ID (2) + flags (1)
    if (flags & 0x80) at += 2; // dependsOn_ES_ID
    if (flags & 0x40) {
      if (at >= es.end) return null;
      at += 1 + bytes[at]!; // URLlength + URLstring
    }
    if (flags & 0x20) at += 2; // OCR_ES_Id
    // The nested descriptors; DecoderConfigDescriptor is the one wanted.
    for (let steps = 0; at < es.end && steps < 16; steps++) {
      const d = descriptor(at, es.end);
      if (!d) return null;
      if (d.tag === 0x04) return d.end > d.start ? bytes[d.start]! : null;
      at = d.end;
    }
    return null;
  }
}

function audioMessage(what: string): string {
  return `This video's sound is ${what}, which WhatsApp can't play. Export it with AAC audio and try again.`;
}

function refuse(message: string): VideoCodecCheck {
  return { ok: false, code: "video_codec_unsupported", message };
}
