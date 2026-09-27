import type { SnippetDto } from "@/types/snippets";

type Millis = { toMillis?: () => number } | null | undefined;

/** Admin-SDK doc → API shape (Timestamps become epoch millis). */
export function snippetToDto(
  id: string,
  d: Record<string, unknown>
): SnippetDto {
  const ms = (v: unknown) => (v as Millis)?.toMillis?.() ?? null;
  return {
    id,
    name: String(d.name ?? ""),
    body: String(d.body ?? ""),
    type: d.type === "email" ? "email" : "text",
    subject: typeof d.subject === "string" ? d.subject : null,
    folder: typeof d.folder === "string" && d.folder ? d.folder : null,
    agencyId: String(d.agencyId ?? ""),
    subAccountId: String(d.subAccountId ?? ""),
    createdByUid: String(d.createdByUid ?? ""),
    createdAt: ms(d.createdAt),
    updatedAt: ms(d.updatedAt),
    lastAgentEditKey: typeof d.lastAgentEditKey === "string" && d.lastAgentEditKey ? d.lastAgentEditKey : null,
    lastAgentEditAt: ms(d.lastAgentEditAt),
  };
}
