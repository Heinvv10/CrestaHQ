import type { ReactNode } from "react";

/**
 * Minimal layout for the /embed/booking/[subAccountId]/[slug] iframe. No
 * navigation, no sidebar — just the booking surface. Unlike the chat embed
 * (fixed 100vh, floats over a bubble) this iframe is sized by the loader
 * script to match its own content height, so no fixed dimensions here.
 */
export default function EmbedBookingLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <div style={{ background: "transparent" }}>{children}</div>;
}
