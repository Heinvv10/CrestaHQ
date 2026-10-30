import { useEffect, useState } from "react";
import {
  SHRINKABLE_IMAGE_TYPES,
  TRANSCODABLE_VIDEO_TYPES,
  uploadCapFor,
  type WhatsAppProviderCapabilities,
} from "@/lib/comms/whatsapp/provider";

/**
 * What the WhatsApp attachment picker (whatsapp-attachment-picker.tsx)
 * offers and how it describes a refusal: the accept list, the host's
 * video-transcode answer, and the pick-time helpers.
 */

/**
 * Every type the picker offers: what the rail sends, plus photos the send
 * route converts to JPEG, plus phone videos where the host converts them.
 */
export function acceptedTypes(caps: WhatsAppProviderCapabilities, host: { videoTranscode: boolean }): string[] {
  return [...new Set([...caps.mediaMimeTypes, ...SHRINKABLE_IMAGE_TYPES, ...TRANSCODABLE_VIDEO_TYPES])].filter(
    (t) => uploadCapFor(caps, t, host) > 0,
  );
}

let videoTranscodeAnswer: Promise<boolean> | null = null;

/**
 * Whether this deployment converts videos (ffmpeg on the server), asked once
 * per page load, and only by a composer on a rail that sends files. False
 * until the answer arrives, and on any failure: the
 * picker then offers only what every host accepts, and the server — which
 * decides — is never more generous than what it said here.
 */
export function useVideoTranscode(ask: boolean): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!ask) return;
    let live = true;
    videoTranscodeAnswer ??= fetch("/api/comms/whatsapp/upload-url")
      .then(async (res) => res.ok && ((await res.json()) as { videoTranscode?: unknown }).videoTranscode === true)
      .catch(() => false);
    void videoTranscodeAnswer.then((v) => {
      if (live) setOn(v);
    });
    return () => {
      live = false;
    };
  }, [ask]);
  return on;
}

/** By name as well as type: some browsers report a .heic file's type as "". */
export function isHeic(file: File): boolean {
  return /^image\/hei[cf]/.test(file.type) || /\.hei[cf]$/i.test(file.name);
}

export function humanSize(bytes: number): string {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${Math.round(bytes / (1 << 10))} KB`;
  return `${bytes} B`;
}
