// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SnippetDto } from "@/types/snippets";

/**
 * A snippet an API agent last wrote carries "edited by API agent <key>
 * <date>" in the snippets table and in the composer's insert picker; a
 * teammate's snippet carries nothing.
 */

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/snippets/client", () => ({ deleteSnippet: vi.fn() }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ({ subAccountId: "sa1", saPath: (p: string) => p }) }));
const snippets = vi.hoisted(() => ({ list: [] as SnippetDto[] }));
vi.mock("@/hooks/use-snippets", () => ({ useSnippets: () => ({ snippets: snippets.list, loading: false, error: null }) }));
vi.mock("@/components/snippets/merge-field-menu", () => ({ MergeFieldMenu: () => null }));

const { SnippetsTable } = await import("./snippets-table");
const { ComposerInserts } = await import("@/components/conversations/composer-inserts");
const { snippetToDto } = await import("@/lib/snippets/to-dto");

const AT = Date.UTC(2026, 8, 20, 12);
const base: SnippetDto = {
  id: "s_human", name: "Welcome", body: "Hi there", type: "text", subject: null, folder: null,
  agencyId: "ag1", subAccountId: "sa1", createdByUid: "u1", createdAt: AT, updatedAt: AT,
  lastAgentEditKey: null, lastAgentEditAt: null,
};
const agent: SnippetDto = { ...base, id: "s_agent", name: "Agent reply", lastAgentEditKey: "lsk_abcd", lastAgentEditAt: AT };
const dated = `edited by API agent lsk_abcd ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(AT))}`;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const badges = () => [...container.querySelectorAll("[data-testid='agent-edit-badge']")].map((b) => b.textContent);

describe("the agent provenance badge", () => {
  it("snippets table: on the agent's row only, with its key and date", () => {
    act(() => root.render(createElement(SnippetsTable, { subAccountId: "sa1", snippets: [base, agent], onEdit: () => {}, onDeleted: () => {} })));
    expect(badges()).toEqual([dated]);
    const rows = [...container.querySelectorAll("[data-testid='snippet-row']")];
    expect(rows[0]!.textContent).not.toContain("API agent");
    expect(rows[1]!.textContent).toContain(dated);
  });

  it("composer insert picker: on the agent's snippet only", () => {
    snippets.list = [base, agent];
    act(() =>
      root.render(
        createElement(ComposerInserts, { mergeContext: {} as never, emailActive: false, onInsert: () => {}, onSubject: () => {} })
      )
    );
    expect(badges()).toEqual([]); // closed
    act(() => container.querySelector<HTMLButtonElement>("button[title='Insert a snippet']")!.click());
    expect(badges()).toEqual([dated]);
    const items = [...container.querySelectorAll("[role='dialog'] button")];
    expect(items.find((b) => b.textContent?.includes("Welcome"))!.textContent).not.toContain("API agent");
  });

  it("the API returns the stamp (and null for a teammate's snippet)", () => {
    const ts = { toMillis: () => AT };
    expect(snippetToDto("s1", { name: "x", body: "y", lastAgentEditKey: "lsk_abcd", lastAgentEditAt: ts })).toMatchObject({ lastAgentEditKey: "lsk_abcd", lastAgentEditAt: AT });
    expect(snippetToDto("s2", { name: "x", body: "y" })).toMatchObject({ lastAgentEditKey: null, lastAgentEditAt: null });
  });
});
