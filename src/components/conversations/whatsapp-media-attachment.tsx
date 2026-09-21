"use client";

import { FileText } from "lucide-react";
import {
  mediaDroppedLabel,
  type WhatsappMedia,
  type WhatsappMediaDropped,
} from "@/types/whatsapp-media";

/**
 * The file a WhatsApp message carried, rendered inside a thread bubble.
 *
 * Shared by BOTH live WhatsApp renderers — the unified inbox
 * (`conversation-thread.tsx`) and the contact profile
 * (`contact-whatsapp-thread.tsx`) — so the same message never looks different
 * in two places in the app.
 *
 * Bytes come from the authorised serving route, not a public Storage URL.
 */
export function WhatsappMediaAttachment({
  contactId,
  messageId,
  media,
  dropped,
}: {
  contactId: string;
  messageId: string;
  media?: WhatsappMedia | null;
  dropped?: WhatsappMediaDropped | null;
}) {
  if (!media) {
    // An operator seeing nothing at all would read the thread as if the
    // customer had sent a bare caption. Say the file was lost instead.
    if (!dropped) return null;
    return (
      <p className="mb-1 text-[11px] italic opacity-70">
        {mediaDroppedLabel(dropped)}
      </p>
    );
  }

  const src = `/api/comms/whatsapp/media/${encodeURIComponent(contactId)}/${encodeURIComponent(messageId)}`;

  if (media.kind === "image" || media.kind === "sticker") {
    return (
      <a href={src} target="_blank" rel="noreferrer" className="mb-1 block">
        {/* eslint-disable-next-line @next/next/no-img-element -- authorised API route, not an optimisable static asset */}
        <img
          src={src}
          alt={media.filename}
          loading="lazy"
          className="max-h-64 rounded-lg"
        />
      </a>
    );
  }

  if (media.kind === "audio") {
    return (
      <audio controls preload="none" src={src} className="mb-1 max-w-full" />
    );
  }

  if (media.kind === "video") {
    return (
      <video
        controls
        preload="metadata"
        src={src}
        className="mb-1 max-h-64 rounded-lg"
      />
    );
  }

  return (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      className="mb-1 flex items-center gap-2 rounded-lg bg-black/5 px-2 py-1.5 underline-offset-2 hover:underline dark:bg-white/10"
    >
      <FileText className="h-4 w-4 shrink-0" />
      <span className="truncate text-xs">{media.filename}</span>
      <span className="shrink-0 text-[10px] opacity-70">
        {humanSize(media.sizeBytes)}
      </span>
    </a>
  );
}

function humanSize(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
