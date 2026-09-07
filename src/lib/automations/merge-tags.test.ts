import { describe, expect, it } from "vitest";

import { resolveMergeTags, type MergeTagSubject } from "./merge-tags";
import { resolveTemplateVariables } from "@/lib/comms/whatsapp/resolve-template-variables";
import type { WhatsappTemplateVariable } from "@/types/whatsapp-templates";

/**
 * {{contact.customFields.<key>}} — operator-defined fields in outbound copy.
 *
 * The two things that must never happen are a raw `{{...}}` token reaching a
 * customer and the literal string "undefined" standing in for a blank field,
 * so every miss case is asserted to render as exactly "".
 */

function subject(
  customFields?: MergeTagSubject["contact"]["customFields"],
): MergeTagSubject {
  return {
    contact: {
      name: "Thandi Mokoena",
      email: "thandi@example.co.za",
      phone: "+27821234567",
      customFields,
    },
    owner: { displayName: "Hein van Vuuren", email: "hein@example.com" },
    workspace: { name: "Blitz Fibre" },
    bookingLink: "",
    unsubscribeLink: "",
  };
}

describe("resolveMergeTags — contact custom fields", () => {
  it("resolves a text custom field by its key", () => {
    expect(
      resolveMergeTags("Hi {{contact.firstName}}, re {{contact.customFields.suburb}}.", subject({ suburb: "Mooikloof" })),
    ).toBe("Hi Thandi, re Mooikloof.");
  });

  it("renders numbers, booleans and multiselect arrays", () => {
    const s = subject({ seats: 12, vip: true, services: ["Fibre", "LTE"] });
    expect(
      resolveMergeTags(
        "{{contact.customFields.seats}}|{{contact.customFields.vip}}|{{contact.customFields.services}}",
        s,
      ),
    ).toBe("12|true|Fibre, LTE");
  });

  it("renders an unknown key as empty string, not the raw tag", () => {
    const out = resolveMergeTags(
      "[{{contact.customFields.no_such_field}}]",
      subject({ suburb: "Mooikloof" }),
    );
    expect(out).toBe("[]");
    expect(out).not.toContain("{{");
    expect(out).not.toContain("undefined");
  });

  it("renders an unset (null) value and an absent map as empty string", () => {
    expect(
      resolveMergeTags("[{{contact.customFields.suburb}}]", subject({ suburb: null })),
    ).toBe("[]");
    expect(resolveMergeTags("[{{contact.customFields.suburb}}]", subject())).toBe("[]");
    expect(
      resolveMergeTags("[{{contact.customFields.suburb}}]", subject(null)),
    ).toBe("[]");
  });

  it("leaves the pre-existing tag set untouched", () => {
    expect(
      resolveMergeTags(
        "{{contact.lastName}}/{{contact.email}}/{{workspace.name}}/{{nope}}",
        subject({ suburb: "Mooikloof" }),
      ),
    ).toBe("Mokoena/thandi@example.co.za/Blitz Fibre/");
  });
});

const v = (position: number, mergeTag: string): WhatsappTemplateVariable => ({
  position,
  source: "merge_tag",
  mergeTag,
  label: `var${position}`,
  sampleValue: "",
});

describe("WhatsApp template variables — custom-field merge tags", () => {
  it("resolves a custom-field merge tag into a positional template value", () => {
    expect(
      resolveTemplateVariables({
        variables: [
          v(1, "contact.firstName"),
          v(2, "contact.customFields.suburb"),
        ],
        subject: subject({ suburb: "Mooikloof" }),
      }),
    ).toEqual(["Thandi", "Mooikloof"]);
  });

  it("sends an empty value, never the raw tag, for an unset custom field", () => {
    expect(
      resolveTemplateVariables({
        variables: [
          v(1, "contact.customFields.suburb"),
        ],
        subject: subject(),
      }),
    ).toEqual([""]);
  });
});
