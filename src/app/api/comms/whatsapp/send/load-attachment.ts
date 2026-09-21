import { NextResponse } from "next/server";
import { checkWhatsappVideoCodecs } from "@/lib/comms/whatsapp/video-codec";
import {
  downloadStaged,
  readStaged,
  type StagedAttachment,
  type StagedObject,
} from "@/lib/comms/whatsapp/staged-upload";
import {
  jpegFilename,
  needsShrink,
  shrinkImage,
  sniffImageType,
  type PhotoType,
} from "@/lib/comms/whatsapp/image-shrink";
import { fitVideo, mp4Filename } from "@/lib/comms/whatsapp/video-transcode";
import type { WhatsAppProviderCapabilities } from "@/lib/comms/whatsapp/provider";
import { mediaKindForMime } from "@/types/whatsapp-media";

/**
 * Turning a checked staged object into what the send route hands the rail:
 * its bytes as they are, a photo re-encoded to fit (image-shrink.ts), or a
 * video transcoded to fit (video-transcode.ts). Split out of route.ts.
 */

/**
 * An MP4 WhatsApp cannot play is accepted by Meta, gets a wamid, and then
 * fails after the thread row already says "sent" — so the codecs are read
 * here, before either rail uploads anything (see video-codec.ts).
 */
function videoCodecRefusal(contentType: string, bytes: Uint8Array): NextResponse | null {
  if (contentType.split(";")[0]!.trim().toLowerCase() !== "video/mp4") return null;
  const codecs = checkWhatsappVideoCodecs(bytes);
  return codecs.ok
    ? null
    : NextResponse.json({ error: codecs.message, code: codecs.code }, { status: 400 });
}

/**
 * The checked object's bytes, with the video codec check run on them — or,
 * for a photo that must be re-encoded, the JPEG made from them.
 */
export async function loadStaged(
  obj: StagedObject,
  filename: string,
  caps: WhatsAppProviderCapabilities,
): Promise<StagedAttachment | NextResponse> {
  let data: Blob;
  try {
    data = await readStaged(obj);
  } catch (err) {
    console.warn("[whatsapp/send] staged read failed", err instanceof Error ? err.message : typeof err);
    return NextResponse.json(
      { error: "The attachment couldn't be read. Attach the file again.", code: "media_invalid" },
      { status: 400 },
    );
  }
  // Every photo, sent unchanged or not, must be one of the three types sharp
  // is let near, by its bytes. See image-shrink.ts.
  let photoType: PhotoType | null = null;
  if (mediaKindForMime(obj.contentType) === "image") {
    photoType = sniffImageType(new Uint8Array(await data.slice(0, 12).arrayBuffer()));
    if (!photoType) {
      return NextResponse.json(
        {
          error: "This file isn't a JPEG, PNG or WebP photo. Save it as a JPEG and attach it again.",
          code: "media_unsupported_type",
        },
        { status: 400 },
      );
    }
  }
  // A photo over the rail's image cap, or in a type it does not send, is
  // re-encoded to fit. So is a real photo signed as another photo type (a
  // PNG named .jpg): as a JPEG, what goes out and what is stored agree.
  const reencode =
    photoType !== null &&
    (photoType !== obj.contentType || needsShrink(caps, obj.contentType, obj.sizeBytes));
  if (reencode && photoType) {
    const shrunk = await shrinkImage(Buffer.from(await data.arrayBuffer()), photoType, caps.maxMediaBytes.image);
    if (!shrunk.ok) {
      return shrunk.code === "media_busy"
        ? NextResponse.json({ error: shrunk.error, code: shrunk.code }, { status: 503, headers: { "Retry-After": "30" } })
        : NextResponse.json({ error: shrunk.error, code: shrunk.code }, { status: 400 });
    }
    return {
      outbound: {
        filename: jpegFilename(filename),
        contentType: shrunk.contentType,
        data: new Blob([new Uint8Array(shrunk.bytes)], { type: shrunk.contentType }),
      },
      staged: obj,
      rewritten: true,
    };
  }
  if (obj.contentType === "video/mp4") {
    const codecs = videoCodecRefusal(obj.contentType, new Uint8Array(await data.arrayBuffer()));
    if (codecs) return codecs;
  }
  return { outbound: { filename, contentType: obj.contentType, data }, staged: obj };
}

/**
 * A phone video on a host that transcodes: streamed to a temp file, sent
 * unchanged when it is already an H.264/AAC MP4 within the rail's cap, else
 * converted to one (video-transcode.ts). The thread's copy is what was sent.
 */
export async function loadVideo(
  obj: StagedObject,
  filename: string,
  caps: WhatsAppProviderCapabilities,
): Promise<StagedAttachment | NextResponse> {
  const fit = await fitVideo((dest) => downloadStaged(obj, dest), obj.contentType, caps.maxMediaBytes.video);
  if (!fit.ok) {
    return fit.code === "media_busy"
      ? NextResponse.json({ error: fit.error, code: fit.code }, { status: 503, headers: { "Retry-After": "30" } })
      : NextResponse.json({ error: fit.error, code: fit.code }, { status: 400 });
  }
  const data = new Blob([new Uint8Array(fit.bytes)], { type: "video/mp4" });
  return fit.transcoded
    ? { outbound: { filename: mp4Filename(filename), contentType: "video/mp4", data }, staged: obj, rewritten: true }
    : { outbound: { filename, contentType: obj.contentType, data }, staged: obj };
}
