import "server-only";

import { resolveMergeTags } from "@/lib/automations/merge-tags";
import { resolveAudiencePage } from "@/lib/broadcasts/audience";
import type { BroadcastAudienceFilter } from "@/types";

/**
 * The values an API agent set that an agent's broadcast would merge into
 * its emails: for each recipient carrying an agent edit stamp, the exact
 * text of every contact merge tag the template uses. The approver reads
 * them (the preview's "Agent-set values"); too many to read means the
 * broadcast is sent from the app instead.
 */

export const AGENT_VALUES_CAP = 50;

const TAG_RE = /\{\{\s*([a-zA-Z0-9_.:-]+)\s*\}\}/g;

/** The contact merge tags a template uses (not the unsubscribe, owner or business tags). */
export function contactTagsUsed(t: { subject?: string | null; body: string }): string[] {
  const text = `${t.subject ?? ""}\n${t.body}`;
  return [...new Set([...text.matchAll(TAG_RE)].map((m) => m[1]).filter((tag) => tag.startsWith("contact.")))].sort();
}

export type AgentValues = Array<{ contactId: string; values: Record<string, string> }>;

/** The agent-set values of the audience, or "too_many" past the cap. */
export async function agentSetValues(subAccountId: string, filter: BroadcastAudienceFilter, tags: string[]): Promise<AgentValues | "too_many"> {
  const out: AgentValues = [];
  if (!tags.length) return out;
  for (let cursor: string | null = null; ; ) {
    const page = await resolveAudiencePage(subAccountId, filter, null, cursor);
    for (const c of page.recipients) {
      if (!(c as { lastAgentEditAt?: unknown }).lastAgentEditAt) continue;
      const subject = {
        contact: { name: c.name ?? "", email: c.email ?? "", phone: c.phone ?? "", customFields: c.customFields ?? null },
        owner: { displayName: "", email: "" },
        workspace: { name: "" },
        bookingLink: "",
        unsubscribeLink: "",
      };
      out.push({ contactId: c.id, values: Object.fromEntries(tags.map((tag) => [tag, resolveMergeTags(`{{${tag}}}`, subject)])) });
      if (out.length > AGENT_VALUES_CAP) return "too_many";
    }
    if (!page.nextCursor) return out;
    cursor = page.nextCursor;
  }
}
