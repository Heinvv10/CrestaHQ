import "server-only";

// Stub — see publish/README.md. No exports are imported by any file that
// ships to the buyer (the real dispute handler that used this is itself
// stubbed to a no-op). Kept as an empty module so the sanitized tree never
// carries the LeadStack-branded dispute-evidence copy.
export {};
