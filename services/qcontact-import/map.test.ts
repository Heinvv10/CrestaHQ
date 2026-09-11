import { describe, expect, it } from "vitest";
import { mapCase, phoneFromQContact, IMPORT_TAG } from "./map.ts";
import type { CaseDetail, ContactDetail } from "./qcontact.ts";

// Shapes copied from a live Fibertime case + contact (digits changed).
const caseDetail: CaseDetail = {
  id: 27140690790,
  label: "General FT1569464",
  lookup_contact_id: 27140690602,
  fields: {
    category: "NewInstallation",
    reference: "FT1569464",
    description: "want fibre",
    c__contact_name: "Oarabile",
    c__contact_number: "e164:27795564958",
    c__location_pin: "-26.1234,28.5678",
    c__dr_location: "MOA",
  },
};
const contact: ContactDetail = {
  id: 27140690602,
  label: "Oarabile Masekwameng",
  fields: {
    first_name: "Oarabile",
    last_name: "Masekwameng",
    telephone: "e164:27795564958",
    addressline_1: "1735 Makwarela street",
    c__drop_number: "DR1234567",
  },
};

describe("phoneFromQContact", () => {
  it("turns the e164: prefix into a +", () => {
    expect(phoneFromQContact("e164:27795564958")).toBe("+27795564958");
  });
  it("rejects blanks and short junk", () => {
    expect(phoneFromQContact("")).toBeUndefined();
    expect(phoneFromQContact("e164:")).toBeUndefined();
    expect(phoneFromQContact(null)).toBeUndefined();
  });
});

describe("mapCase", () => {
  it("builds the upsert body from the contact, with the case id and tag", () => {
    const m = mapCase(caseDetail, contact);
    expect(m).toEqual({
      ok: true,
      body: {
        phone: "+27795564958",
        name: "Oarabile Masekwameng",
        address: "1735 Makwarela street",
        source: "qcontact",
        tags_add: [IMPORT_TAG],
        custom_fields: {
          qcontact_case_id: "27140690790",
          qcontact_case_ref: "FT1569464",
          qcontact_location_pin: "-26.1234,28.5678",
          velocity_dr_number: "DR1234567",
        },
      },
    });
  });

  it("falls back to the case's own number and contact name when there is no linked contact", () => {
    const m = mapCase(caseDetail, null);
    expect(m.ok && m.body.phone).toBe("+27795564958");
    expect(m.ok && m.body.name).toBe("Oarabile");
  });

  it("sends only the custom keys that have a value (the upsert refuses null-clearing by accident)", () => {
    const bare: CaseDetail = { ...caseDetail, fields: { reference: "FT1" } };
    const m = mapCase(bare, { ...contact, fields: { first_name: "A", telephone: "e164:27795564958" } });
    expect(m.ok && m.body.custom_fields).toEqual({ qcontact_case_id: "27140690790", qcontact_case_ref: "FT1" });
    expect(m.ok && "address" in m.body).toBe(false);
  });

  it("skips a case with no phone anywhere", () => {
    const m = mapCase({ ...caseDetail, fields: {} }, { ...contact, fields: { first_name: "A" } });
    expect(m).toEqual({ ok: false, reason: "no_phone" });
  });

  it("skips a case with a phone but no name", () => {
    const m = mapCase({ ...caseDetail, fields: {} }, { ...contact, label: "", fields: { telephone: "e164:27795564958" } });
    expect(m).toEqual({ ok: false, reason: "no_name" });
  });
});
