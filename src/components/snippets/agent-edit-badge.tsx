import type { SnippetDto } from "@/types/snippets";

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/**
 * "edited by API agent <key> <date>" on a snippet an API agent last wrote
 * (its text may be the agent's, not a teammate's). Nothing otherwise.
 */
export function AgentEditBadge({ snippet }: { snippet: Pick<SnippetDto, "lastAgentEditKey" | "lastAgentEditAt"> }) {
  if (!snippet.lastAgentEditKey) return null;
  const when = snippet.lastAgentEditAt ? ` ${dateFmt.format(new Date(snippet.lastAgentEditAt))}` : "";
  return (
    <span
      data-testid="agent-edit-badge"
      className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-normal text-amber-900 dark:bg-amber-900/30 dark:text-amber-200"
    >
      edited by API agent {snippet.lastAgentEditKey}
      {when}
    </span>
  );
}
