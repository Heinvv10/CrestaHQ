"use client";

import { MapPin } from "lucide-react";
import {
  formatCoordinates,
  googleMapsUrl,
  locationPreviewLabel,
  parseWhatsappLocation,
} from "@/types/whatsapp-location";

/**
 * A location the customer shared, rendered inside a thread bubble.
 *
 * Shared by BOTH live WhatsApp renderers, like `WhatsappMediaAttachment`.
 *
 * The row is DATA, so it is re-validated here. The only href is built from
 * the two numbers; `name` and `address` are customer text and render as text
 * (React escapes them), and the customer's `url` is not rendered at all. No
 * map embed: an embed would send the customer's coordinates to a tile server
 * every time an operator opens the thread.
 */
export function WhatsappLocationAttachment({ location }: { location: unknown }) {
  const loc = parseWhatsappLocation(location);
  if (!loc) return null;
  return (
    <div className="mb-1 flex items-start gap-2 rounded-lg bg-black/5 px-2 py-1.5 dark:bg-white/10">
      <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-0.5">
        {loc.name && <p className="font-medium break-words">{loc.name}</p>}
        {loc.address && <p className="text-xs break-words opacity-80">{loc.address}</p>}
        <p className="text-xs tabular-nums opacity-70">{formatCoordinates(loc)}</p>
        <a
          href={googleMapsUrl(loc)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-medium underline underline-offset-2"
        >
          Open in Google Maps
        </a>
      </div>
    </div>
  );
}

/**
 * Whether the bubble should skip its body text. A location row's body is the
 * label the webhook synthesised (so the inbox preview is never empty); showing
 * it above the card says the same thing twice. Anything else in the body —
 * a live-location caption the customer typed — still renders.
 */
export function isLocationLabelBody(body: string, location: unknown): boolean {
  const loc = parseWhatsappLocation(location);
  return loc !== null && body === locationPreviewLabel(loc);
}
