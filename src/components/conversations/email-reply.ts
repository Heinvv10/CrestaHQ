import type { EmailMessageDoc } from "@/types/email";

export function emailReplyFields(
  message: Pick<EmailMessageDoc, "subject" | "messageId" | "references"> | null
) {
  if (!message) return { subject: "", references: [] as string[] };
  const references = [
    ...new Set(message.references.filter((id) => id !== message.messageId)),
    message.messageId,
  ];
  return {
    subject: /^re:/i.test(message.subject)
      ? message.subject
      : `Re: ${message.subject}`,
    inReplyTo: message.messageId,
    // The send endpoint accepts at most 100 IDs. Retain the root and latest ancestry.
    references: references.length > 100
      ? [references[0], ...references.slice(-99)]
      : references,
  };
}
