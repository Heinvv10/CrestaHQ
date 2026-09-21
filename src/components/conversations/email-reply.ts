import type { EmailMessageDoc } from "@/types/email";

// The shape /api/comms/email/send accepts. Imported mail can carry IDs it
// rejects (mailparser only wraps a bare `Message-ID: 1234` in brackets), and
// one such ID would make the whole reply 400 — so they are left off instead.
const sendable = (id: string | null): id is string =>
  typeof id === "string" && id.length <= 998 && /^<[^\s<>]+@[^\s<>]+>$/.test(id);

export function emailReplyFields(
  message: Pick<
    EmailMessageDoc,
    "subject" | "messageId" | "inReplyTo" | "references"
  > | null
) {
  if (!message) return { subject: "", references: [] as string[] };
  // RFC 5322 §3.6.4: the parent's References — or, when it has none, its
  // In-Reply-To — followed by the parent's own Message-ID.
  const ancestry: (string | null)[] = message.references.length
    ? message.references
    : [message.inReplyTo];
  const references = [
    ...new Set(ancestry.filter((id) => id !== message.messageId)),
    message.messageId,
  ].filter(sendable);
  return {
    subject: /^re:/i.test(message.subject)
      ? message.subject
      : `Re: ${message.subject}`,
    inReplyTo: sendable(message.messageId) ? message.messageId : undefined,
    // The send endpoint accepts at most 100 IDs. Retain the root and latest ancestry.
    references: references.length > 100
      ? [references[0], ...references.slice(-99)]
      : references,
  };
}
