import { LegacyRedirect } from "@/components/legacy-redirect";

// Flat route → the user's first-membership sub-account inbox. Exists for
// the PWA manifest shortcut (long-press app icon → Conversations), which
// must be a static URL; mirrors the other legacy flat routes.
export default function LegacyConversations() {
  return <LegacyRedirect toSubPath="/conversations" />;
}
