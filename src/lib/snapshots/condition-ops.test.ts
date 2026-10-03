import { describe, expect, it } from "vitest";

import { sanitizeNodes } from "./apply";
import { toPortablePayload } from "./portable";
import type { SnapshotPayload } from "@/types/snapshots";
import type { WorkflowNode } from "@/types/workflows";

/** A snapshot carries a workflow's text-op conditions across unchanged. */

const conditions = {
  match: "all",
  all: [
    { field: "reply.text", op: "starts_with", value: "yes" },
    { field: "reply.text", op: "not_contains", value: "but" },
  ],
};
const filters = { all: [{ field: "company", op: "not_contains", value: "test" }] };
const ifElse = {
  n1: { id: "n1", type: "if_else", config: { conditions }, branches: { whenTrue: null, whenFalse: null } },
} as unknown as Record<string, WorkflowNode>;

describe("snapshot condition ops", () => {
  it("apply keeps starts_with / not_contains on an if_else", () => {
    expect(sanitizeNodes(ifElse).n1.config).toEqual({ conditions });
  });

  it("a portable (shared) copy keeps them on the if_else and the trigger", () => {
    const payload = {
      workflows: [{ sourceId: "wf_src", name: "Reply branch", trigger: { type: "contact.created", filters }, nodes: ifElse }],
    } as unknown as SnapshotPayload;

    const wf = toPortablePayload(payload, new Set()).workflows[0];
    expect(wf.nodes?.n1.config).toEqual({ conditions });
    expect(wf.trigger.filters).toEqual(filters);
  });
});
