/**
 * Scopes for a member's Google Calendar connection. `calendar.events` is the
 * one that matters (read busy time, write bookings, primary calendar only);
 * `openid email` exist so the card can say "Connected as …". Adding a scope
 * means changing the OAuth consent screen, so this is a fixed list.
 */
export const GCAL_SCOPE = "https://www.googleapis.com/auth/calendar.events";
export const GCAL_SCOPES = ["openid", "email", GCAL_SCOPE] as const;
