import { describe, expect, it } from "vitest";
import { planFields, roleOf, type FormField, type FormIdentity } from "./mapping";

const ID: FormIdentity = {
  business: "Cresta HQ",
  email: "info@crestahq.com",
  phone: "+27784356159",
  subject: "Enquiry: plumber in Gqeberha",
  message: "Hi,\n\nDo you do plumber in Gqeberha?",
  service: "plumber",
  town: "Gqeberha",
};
let n = 0;
const field = (hint: string, over: Partial<FormField> = {}): FormField => ({
  key: `f${n++}`, tag: "input", type: "text", hint, named: hint, required: false, visible: true, ...over,
});
const plan = (fields: FormField[], id: FormIdentity = ID) => planFields(fields, id);
const filled = (fields: FormField[], id?: FormIdentity) => {
  const p = plan(fields, id);
  if (!p.ok) throw new Error(`refused: ${p.code} ${p.reason}`);
  return Object.fromEntries(p.fills.map((f) => [fields.find((x) => x.key === f.key)!.hint, f.value]));
};

describe("roleOf", () => {
  it.each([
    ["your name", "text", "name"], ["full name | fullname", "text", "name"], ["naam", "text", "name"],
    ["first name | fname", "text", "first"], ["surname", "text", "last"], ["last_name", "text", "last"],
    ["email address", "text", "email"], ["x", "email", "email"], ["phone", "text", "phone"], ["x", "tel", "phone"],
    ["whatsapp number", "text", "phone"], ["company name", "text", "company"], ["business", "text", "company"],
    ["subject", "text", "subject"], ["your enquiry", "text", "message"], ["website", "text", null], ["city", "text", "town"],
    ["company name | organization", "text", "company"], ["business name | bizname", "text", "company"], ["billing_state", "text", null],
  ])("%s (%s) → %s", (hint, type, role) => {
    expect(roleOf({ tag: "input", type, hint, named: hint })).toBe(role);
  });

  it.each([
    "town or suburb | example: edenvale | where | bizwhere | address-level2", "town / city", "suburb", "x | address-level2", "dorp",
    "billing_city", "your_city", "town-name", "suburb or estate",
  ])("%s → town", (hint) => {
    expect(roleOf({ tag: "input", type: "text", hint, named: hint })).toBe("town");
  });

  it.each([
    "street address", "address | street-address", "postal code", "city | postal-code", "province", "state", "country",
    "area code", "address", "location", "area", "address line 1 | address-line1", "region | address-level1",
    // Each says town, and each is excluded by its own NOT_TOWN word.
    "town address", "city | address", "dorp | adres", "town | street", "dorp | straat", "city | postal", "city postcode",
    "dorp | poskode", "city zip", "city | state", "town | province", "voorstad | provinsie", "city | country", "city | area-code",
    "suburb | address-line1", "city | address-level1", "townhouse", "capacity", "hometown", "city areacode",
    "zipcode | city", "city | zip_code", "city_code",
  ])("%s is never the town", (hint) => {
    expect(roleOf({ tag: "input", type: "text", hint, named: hint })).not.toBe("town");
  });

  it("the town is never read from a placeholder (example values): company and subject fields keep their role", () => {
    const r = (label: string, placeholder: string) =>
      roleOf({ tag: "input", type: "text", hint: `${label.split(" | ")[0]} | ${placeholder} | ${label.split(" | ").slice(1).join(" | ")}`, named: label });
    expect(r("business name | business", "e.g. cape town plumbers")).toBe("company");
    expect(r("business name | bizname", "e.g. city plumbing")).toBe("company");
    expect(r("subject | subject", "town house enquiry")).toBe("subject");
    expect(r("your name | name", "e.g. sam from cape town")).toBe("name");
    expect(r("how can we help | help", "e.g. a burst geyser in my town")).toBe("message");
    expect(r("town or suburb | where | address-level2", "example: edenvale")).toBe("town");
  });

  it("a field that says both business and town is ambiguous: no role (a required one refuses)", () => {
    for (const hint of ["business city", "company town", "business_city", "organisation | address-level2"]) {
      expect(roleOf({ tag: "input", type: "text", hint, named: hint })).toBeNull();
    }
    expect(plan([field("business city", { required: true }), field("m", { tag: "textarea" })])).toMatchObject({
      ok: false, code: "unmapped_required", reason: "Required fields it can't fill: business city.",
    });
  });

  it("a textarea is the message unless it says it is an address", () => {
    expect(roleOf({ tag: "textarea", type: "", hint: "anything", named: "anything" })).toBe("message");
    expect(roleOf({ tag: "textarea", type: "", hint: "street address", named: "street address" })).toBeNull();
    expect(roleOf({ tag: "textarea", type: "", hint: "how can we help? | e.g. a leak at my house in town", named: "how can we help? | e.g. a leak at my house in town" })).toBe("message");
  });
});

describe("planFields", () => {
  it("fills name, email, phone, company, subject and message with the workspace's identity", () => {
    expect(
      filled([
        field("name"), field("email", { type: "email" }), field("phone", { type: "tel" }), field("company"),
        field("subject"), field("message", { tag: "textarea", type: "" }),
      ]),
    ).toEqual({
      name: "Cresta HQ", email: "info@crestahq.com", phone: "+27784356159", company: "Cresta HQ",
      subject: "Enquiry: plumber in Gqeberha", message: ID.message,
    });
  });

  it("splits the business name over first and last name", () => {
    const first = field("first name");
    const last = field("last name");
    const msg = field("m", { tag: "textarea" });
    expect(filled([first, last, msg])).toMatchObject({ "first name": "Cresta", "last name": "HQ" });
    expect(filled([first, last, msg], { ...ID, business: "Cresta" })).toMatchObject({ "first name": "Cresta", "last name": "Cresta" });
  });

  it("never fills a hidden field or a honeypot", () => {
    const p = plan([
      field("website", { visible: false }), field("token", { type: "hidden", visible: false }),
      field("your name"), field("m", { tag: "textarea" }), field("email confirm", { visible: false, required: true }),
    ]);
    expect(p.ok && p.fills.map((f) => f.role)).toEqual(["name", "message"]);
  });

  it("picks the service option that names the service; else leaves the default", () => {
    const options = [{ value: "", text: "Choose…" }, { value: "p1", text: "Plumber call-out" }, { value: "o", text: "Other" }];
    const select = field("service", { tag: "select", type: "", options, value: "" });
    const p = plan([select, field("m", { tag: "textarea" })]);
    expect(p.ok && p.fills[0]).toMatchObject({ role: "service", value: "p1", kind: "select" });
    const other = plan([field("service", { tag: "select", type: "", options, value: "" }), field("m", { tag: "textarea" })], { ...ID, service: "roofing" });
    expect(other.ok && other.fills.map((f) => f.role)).toEqual(["message"]);
    // A select that is not a service/reason picker is never changed.
    const country = plan([field("country", { tag: "select", type: "", options: [{ value: "p", text: "plumber" }], value: "za" }), field("m", { tag: "textarea" })]);
    expect(country.ok && country.fills.map((f) => f.role)).toEqual(["message"]);
  });

  it("refuses a required field it cannot fill truthfully, naming it", () => {
    const p = plan([field("your name"), field("street address", { required: true }), field("m", { tag: "textarea" })]);
    expect(p).toEqual({ ok: false, code: "unmapped_required", reason: "Required fields it can't fill: street address." });
    const select = field("province", { tag: "select", type: "", required: true, value: "", options: [{ value: "", text: "-" }] });
    expect(plan([select, field("m", { tag: "textarea" })])).toMatchObject({ ok: false, code: "unmapped_required" });
    expect(plan([field("phone", { type: "tel", required: true }), field("m", { tag: "textarea" })], { ...ID, phone: null })).toMatchObject({
      ok: false, code: "unmapped_required", reason: expect.stringContaining("phone"),
    });
    expect(plan([field("budget", { type: "radio", required: true }), field("m", { tag: "textarea" })])).toMatchObject({ code: "unmapped_required" });
  });

  it("fills a required town field with the enquiry's town (the crestahq.com form, plus a message)", () => {
    const where = field("town or suburb | example: edenvale | where | bizwhere | address-level2", { required: true });
    const p = plan([field("your name", { required: true }), where, field("m", { tag: "textarea" })]);
    expect(p.ok && p.fills.find((f) => f.key === where.key)).toEqual({ key: where.key, role: "town", value: "Gqeberha", kind: "fill" });
    expect(p.ok && p.roles).toEqual(["name", "town", "message"]);
  });

  it("without a town, a required town field still refuses and an optional one is left empty", () => {
    for (const town of [null, ""]) {
      expect(plan([field("town or suburb", { required: true }), field("m", { tag: "textarea" })], { ...ID, town })).toEqual({
        ok: false, code: "unmapped_required", reason: "Required fields it can't fill: town or suburb.",
      });
      const p = plan([field("city"), field("m", { tag: "textarea" })], { ...ID, town });
      expect(p.ok && p.fills.map((f) => f.role)).toEqual(["message"]);
    }
  });

  it("the crestahq.com form as it stands (no message field) still refuses — for the message, no longer the town", () => {
    const p = plan([
      field("your name | person", { required: true }), field("business name | business", { required: true }),
      field("town or suburb | where | address-level2", { required: true }), field("mobile number (whatsapp) | phone", { type: "tel", required: true }),
      field("email address (optional) | email", { type: "email" }),
    ]);
    expect(p).toEqual({ ok: false, code: "unmapped_required", reason: "The form has no message field for the enquiry." });
  });

  it("an optional field it cannot fill is left empty, and an optional phone without a number too", () => {
    const p = plan([field("phone", { type: "tel" }), field("website"), field("m", { tag: "textarea" })], { ...ID, phone: null });
    expect(p.ok && p.fills.map((f) => f.role)).toEqual(["message"]);
  });

  it("refuses a required consent checkbox; never ticks an optional one", () => {
    expect(plan([field("I agree to the privacy policy", { type: "checkbox", required: true }), field("m", { tag: "textarea" })])).toMatchObject({
      ok: false, code: "consent_checkbox",
    });
    const p = plan([field("subscribe to our newsletter", { type: "checkbox" }), field("m", { tag: "textarea" })]);
    expect(p.ok && p.fills.map((f) => f.role)).toEqual(["message"]);
  });

  it("refuses a required file upload; ignores an optional one", () => {
    expect(plan([field("cv", { type: "file", required: true }), field("m", { tag: "textarea" })])).toMatchObject({ ok: false, code: "file_upload" });
    expect(plan([field("photo", { type: "file" }), field("m", { tag: "textarea" })]).ok).toBe(true);
  });

  it("refuses a form with nowhere to put the enquiry", () => {
    expect(plan([field("name"), field("email", { type: "email" })])).toMatchObject({ ok: false, code: "unmapped_required" });
  });
});
