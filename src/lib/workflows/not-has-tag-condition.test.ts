import { describe, expect, it } from "vitest";

import { evalConditionGroup } from "@/lib/workflows/conditions";
import { CONDITION_OPS } from "@/lib/workflows/catalog";
import type { Contact } from "@/types/contacts";

/**
 * `not_has_tag` exists so a campaign can EXCLUDE an audience — the shape every
 * opt-out flag needs ("do not send to anyone carrying no-marketing-automation").
 *
 * Before it existed the only negations were `not_equals` and `not_set`, and
 * neither can express this over `tags`: the field is an array, so it
 * stringifies to "a,b,c" and `not_equals` is true for nearly every contact.
 * A filter written that way reads as "exclude these people" and admits almost
 * all of them — which is why the last test here asserts the difference rather
 * than trusting the operator name.
 */

function contact(over: Partial<Contact> = {}): Contact {
  return {
    id: "c1",
    subAccountId: "sa1",
    tags: [],
    ...over,
  } as Contact;
}

const OPT_OUT = "no-marketing-automation";

function excludesOptOut(c: Contact): boolean {
  return evalConditionGroup(
    { all: [{ field: "tags", op: "not_has_tag", value: OPT_OUT }] },
    c,
  );
}

describe("not_has_tag", () => {
  it("refuses a contact carrying the tag", () => {
    expect(excludesOptOut(contact({ tags: [OPT_OUT] }))).toBe(false);
    expect(
      excludesOptOut(contact({ tags: ["cold-outreach", OPT_OUT, "lead"] })),
    ).toBe(false);
  });

  it("admits a contact that does not carry it", () => {
    expect(excludesOptOut(contact({ tags: ["cold-outreach"] }))).toBe(true);
    expect(excludesOptOut(contact({ tags: [] }))).toBe(true);
  });

  it("admits a contact with NO tags field — excluded from nothing", () => {
    // The opposite reading would silently drop every contact whose tags field
    // is absent from a campaign that only means "not opted out".
    expect(excludesOptOut(contact({ tags: undefined }))).toBe(true);
  });

  it("is exactly the negation of has_tag on the same contact", () => {
    for (const tags of [[OPT_OUT], ["other"], [], undefined]) {
      const c = contact({ tags });
      const has = evalConditionGroup(
        { all: [{ field: "tags", op: "has_tag", value: OPT_OUT }] },
        c,
      );
      expect(excludesOptOut(c)).toBe(!has);
    }
  });

  it("composes with the send-tag filter the campaigns actually use", () => {
    const group = {
      all: [
        { field: "tags", op: "has_tag" as const, value: "cresta-send-audit-offer" },
        { field: "tags", op: "not_has_tag" as const, value: OPT_OUT },
      ],
    };
    // Tagged for the campaign but opted out — the case that matters.
    expect(
      evalConditionGroup(
        group,
        contact({ tags: ["cresta-send-audit-offer", OPT_OUT] }),
      ),
    ).toBe(false);
    // Tagged for the campaign and not opted out.
    expect(
      evalConditionGroup(group, contact({ tags: ["cresta-send-audit-offer"] })),
    ).toBe(true);
    // Opted out and not tagged — refused by the send-tag half.
    expect(evalConditionGroup(group, contact({ tags: [OPT_OUT] }))).toBe(false);
  });

  it("does what not_equals CANNOT — the trap this operator replaces", () => {
    // A contact who IS opted out. `not_equals` compares the stringified array
    // against the bare tag, so it admits them; `not_has_tag` refuses them.
    const optedOut = contact({ tags: ["cold-outreach", OPT_OUT] });
    const viaNotEquals = evalConditionGroup(
      { all: [{ field: "tags", op: "not_equals", value: OPT_OUT }] },
      optedOut,
    );
    expect(viaNotEquals).toBe(true); // the trap: opted-out contact admitted
    expect(excludesOptOut(optedOut)).toBe(false); // the fix
  });

  it("is offered by the builder, or nobody can select it", () => {
    // The operator being evaluable is not the same as it being reachable. A
    // condition the builder cannot emit is one every campaign goes without.
    expect(CONDITION_OPS.map((o) => o.value)).toContain("not_has_tag");
  });
});
