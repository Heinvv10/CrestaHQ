import { describe, it, expect } from "vitest";
import { evalConditionGroup, REPLY_TEXT_FIELD } from "./conditions";
import type { Contact } from "@/types/contacts";
import type { ConditionGroup } from "@/types/workflows";

/**
 * Branching on WHAT a contact replied, not merely that they replied.
 *
 * `wait_for_reply` only ever recorded `replied:<channel>`, so an if_else after
 * it could read contact fields and nothing else. The Blitz and Velocity review
 * flows branch on a button answer ("Good" vs "Could be better"), which is not
 * a contact field — without this the negative branch is unreachable and every
 * customer takes the positive path.
 */

const contact = (over: Partial<Contact> = {}) =>
  ({
    id: "c1",
    name: "Thabo",
    email: "t@example.com",
    phone: "+27821234567",
    tags: ["blitz-customer"],
    ...over,
  }) as unknown as Contact;

const group = (value: string, op = "contains"): ConditionGroup =>
  ({ all: [{ field: REPLY_TEXT_FIELD, op, value }] }) as ConditionGroup;

describe("branching on the reply text", () => {
  it("matches the positive button answer", () => {
    expect(
      evalConditionGroup(group("good"), contact(), { replyText: "Good" }),
    ).toBe(true);
  });

  it("does NOT match the positive branch on the negative answer", () => {
    // The compliance case: if this returned true, someone who said the
    // installation went badly would be sent down the review-ask path.
    expect(
      evalConditionGroup(group("good"), contact(), {
        replyText: "Could be better",
      }),
    ).toBe(false);
  });

  it("matches the negative answer on its own branch", () => {
    expect(
      evalConditionGroup(group("could be better"), contact(), {
        replyText: "Could be better",
      }),
    ).toBe(true);
  });

  it("is false when no reply context is supplied at all", () => {
    // A trigger filter passes no context. A reply.text condition there must
    // never pass — the trigger fires before any reply exists.
    expect(evalConditionGroup(group("good"), contact())).toBe(false);
    expect(evalConditionGroup(group("good"), contact(), { replyText: null })).toBe(
      false,
    );
  });

  it("still evaluates contact fields normally alongside a reply condition", () => {
    const g = {
      all: [
        { field: REPLY_TEXT_FIELD, op: "contains", value: "good" },
        { field: "tags", op: "has_tag", value: "blitz-customer" },
      ],
    } as ConditionGroup;
    expect(evalConditionGroup(g, contact(), { replyText: "Good thanks" })).toBe(
      true,
    );
    expect(
      evalConditionGroup(g, contact({ tags: [] }), { replyText: "Good thanks" }),
    ).toBe(false);
  });

  it("leaves every existing contact-field condition unaffected", () => {
    // Regression guard: the context parameter is additive.
    const g = { all: [{ field: "email", op: "is_set" }] } as ConditionGroup;
    expect(evalConditionGroup(g, contact())).toBe(true);
    expect(evalConditionGroup(g, contact({ email: "" }))).toBe(false);
  });

  it("is case-insensitive, because button labels arrive with vendor casing", () => {
    expect(
      evalConditionGroup(group("COULD BE BETTER"), contact(), {
        replyText: "could be better",
      }),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Seam tests: the wiring, not the helper.                             */
/*                                                                      */
/* The pure-function tests above would all pass while the feature was   */
/* completely dead — if execIfElse never read the reply off the run, or */
/* if resumeWaitingRunsOnReply never wrote it there. These two cross    */
/* those joins.                                                         */
/* ------------------------------------------------------------------ */

import type { WorkflowNode } from "@/types/workflows";

const ifElseCtx = (conditions: ConditionGroup, triggerContext: Record<string, unknown>) =>
  ({
    node: { id: "n1", type: "if_else", config: { conditions } } as unknown as WorkflowNode,
    contact: contact(),
    subAccount: {} as never,
    owner: { displayName: "", email: "" },
    subAccountId: "sa_1",
    agencyId: "ag_1",
    createdByUid: "u_1",
    triggerContext,
  }) as never;

describe("execIfElse — reads the reply off the run", () => {
  it("takes the true branch on the answer stored by the resume", async () => {
    const { execIfElse } = await import("./engine");
    const r = await execIfElse(
      ifElseCtx(group("could be better"), {
        lastReply: { text: "Could be better", channel: "whatsapp" },
      }),
    );
    expect(r.result).toEqual({ kind: "branch", value: true });
  });

  it("takes the false branch when the run carries a different answer", async () => {
    const { execIfElse } = await import("./engine");
    const r = await execIfElse(
      ifElseCtx(group("could be better"), {
        lastReply: { text: "Good", channel: "whatsapp" },
      }),
    );
    expect(r.result).toEqual({ kind: "branch", value: false });
  });

  it("takes the false branch when the run carries no reply at all", async () => {
    const { execIfElse } = await import("./engine");
    const r = await execIfElse(ifElseCtx(group("good"), {}));
    expect(r.result).toEqual({ kind: "branch", value: false });
  });
});
