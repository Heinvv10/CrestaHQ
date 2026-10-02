import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * docs/features/agent-api-tools.md is rendered from the registry
 * (agent-api-doc.ts). A capability added, removed or re-classed without
 * regenerating it fails here. Regenerate with:
 *   UPDATE_AGENT_API_DOCS=1 pnpm exec vitest run src/lib/ai-suite/agent-api-doc.test.ts
 */

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => ({}) }));

const { AI_SUITE_CAPABILITIES } = await import("./capabilities");
const { agentCallable } = await import("@/lib/api/agent-dispatch");
const { PREVIEW_NOTES, renderAgentToolsDoc } = await import("./agent-api-doc");

const DOC = join(process.cwd(), "docs/features/agent-api-tools.md");
const agentTools = AI_SUITE_CAPABILITIES.filter(agentCallable);

describe("docs/features/agent-api-tools.md", () => {
  it("matches the registry", () => {
    const rendered = renderAgentToolsDoc(agentTools);
    if (process.env.UPDATE_AGENT_API_DOCS === "1") writeFileSync(DOC, rendered);
    expect(readFileSync(DOC, "utf8"), "stale: regenerate it (see this file's header)").toBe(rendered);
  });

  it("agent-api.md states the real tool count", () => {
    const doc = readFileSync(join(process.cwd(), "docs/features/agent-api.md"), "utf8");
    expect(doc).toContain(`${agentTools.length} tools today`);
  });

  it("every tool that can need a person says what its preview shows; no note is left over", () => {
    const approving = agentTools.filter((c) => c.approval || c.approvalFor).map((c) => c.name);
    expect(approving.filter((n) => !PREVIEW_NOTES[n])).toEqual([]);
    expect(Object.keys(PREVIEW_NOTES).filter((n) => !approving.includes(n))).toEqual([]);
    // A per-call class the table can't name would show as a plain "write".
    expect(agentTools.filter((c) => c.approvalFor && !c.approvalHint).map((c) => c.name)).toEqual([]);
  });
});
