import { describe, expect, it, vi } from "vitest";

// The module under test imports the Admin SDK + the contacts service at the
// top level for `reconcileContactFromCapture` (not tested here — it's
// Firestore-heavy). Stub them so importing the pure parsers is cheap and
// can't touch a real credential.
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => null }));
vi.mock("@/lib/server/contacts-service", () => ({
  emitContactCreatedById: () => Promise.resolve(),
}));

import { parseCaptureMarker, parseFormMarker } from "./capture";

/**
 * The capture markers are LLM output, so they're treated as hostile input:
 * a model can emit a half-written marker, an unknown field, a marker inside
 * a sentence, or two markers at once. Two invariants matter:
 *
 *   1. Nothing bogus becomes contact data (a malformed marker must not
 *      produce a capture).
 *   2. Whatever happened, the visitor never SEES marker syntax — a leaked
 *      "[[capture ...]]" in the chat bubble is user-visible breakage.
 */

/** No `[[capture`/`[[form` substring may survive into visitor-facing text. */
function expectNoMarkerLeak(text: string) {
  expect(text).not.toMatch(/\[\[\s*(capture|form)\b/i);
}

describe("parseCaptureMarker — well-formed markers", () => {
  it("extracts all three fields and strips the marker", () => {
    const { cleanText, capture } = parseCaptureMarker(
      'Thanks Jane, I\'ll pass that on.\n[[capture name="Jane Doe" email="jane@example.com" phone="+61400000000"]]',
    );
    expect(capture).toEqual({
      name: "Jane Doe",
      email: "jane@example.com",
      phone: "+61400000000",
    });
    expect(cleanText).toBe("Thanks Jane, I'll pass that on.");
    expectNoMarkerLeak(cleanText);
  });

  it("accepts a partial marker (only the fields the model had)", () => {
    const { capture } = parseCaptureMarker('ok [[capture email="a@b.co"]]');
    expect(capture).toEqual({ name: null, email: "a@b.co", phone: null });
  });

  it("is case-insensitive on the marker keyword and field names", () => {
    const { capture, cleanText } = parseCaptureMarker(
      'Sure. [[CAPTURE NAME="Bob" EMAIL="b@c.io"]]',
    );
    expect(capture).toEqual({ name: "Bob", email: "b@c.io", phone: null });
    expectNoMarkerLeak(cleanText);
  });

  it("strips a marker embedded mid-text, not just at the end", () => {
    const { cleanText, capture } = parseCaptureMarker(
      'Got it [[capture name="Ann"]] — someone will call you.',
    );
    expect(capture?.name).toBe("Ann");
    expectNoMarkerLeak(cleanText);
    expect(cleanText).toContain("someone will call you");
  });

  it("collapses the blank-line hole the stripped marker leaves behind", () => {
    const { cleanText } = parseCaptureMarker(
      'Line one\n\n[[capture name="Ann"]]\n\nLine two',
    );
    expect(cleanText).toBe("Line one\n\nLine two");
  });

  it("caps a runaway name at 200 chars", () => {
    const long = "x".repeat(500);
    const { capture } = parseCaptureMarker(`hi [[capture name="${long}"]]`);
    expect(capture?.name).toHaveLength(200);
  });
});

describe("parseCaptureMarker — hostile / malformed input", () => {
  it("returns no capture when there is no marker", () => {
    const raw = "How can I help you today?";
    expect(parseCaptureMarker(raw)).toEqual({ cleanText: raw, capture: null });
  });

  it("ignores an unterminated marker and leaves the text untouched", () => {
    // No closing ]] — must NOT be treated as a capture.
    const raw = 'sure [[capture name="Jane"';
    const { capture } = parseCaptureMarker(raw);
    expect(capture).toBeNull();
  });

  it("ignores unknown field names", () => {
    const { capture } = parseCaptureMarker(
      'ok [[capture address="12 Fake St" ssn="123" name="Jane"]]',
    );
    expect(capture).toEqual({ name: "Jane", email: null, phone: null });
  });

  it("drops an invalid email rather than storing it", () => {
    const { capture } = parseCaptureMarker(
      'ok [[capture email="not-an-email" name="Jane"]]',
    );
    expect(capture?.email).toBeNull();
  });

  it("drops an invalid phone rather than storing it", () => {
    const { capture } = parseCaptureMarker(
      'ok [[capture phone="call me" name="Jane"]]',
    );
    expect(capture?.phone).toBeNull();
  });

  it("returns capture=null (not an empty shell) when every field is invalid", () => {
    const { capture, cleanText } = parseCaptureMarker(
      'ok [[capture email="nope" phone="nope"]]',
    );
    expect(capture).toBeNull();
    // ...but the marker is still stripped so the visitor never sees it.
    expectNoMarkerLeak(cleanText);
    expect(cleanText).toBe("ok");
  });

  it("ignores fields with unquoted values", () => {
    const { capture } = parseCaptureMarker("ok [[capture name=Jane]]");
    expect(capture).toBeNull();
  });

  it("does not treat marker-looking prose as a marker", () => {
    const raw = "You can send [[capture]] style markers, but I won't.";
    expect(parseCaptureMarker(raw).capture).toBeNull();
  });

  it("strips the FIRST marker when the model emits two", () => {
    // Known behaviour: one marker per reply. The first wins; assert the
    // fields come from it so a second marker can't overwrite the capture.
    const { capture } = parseCaptureMarker(
      'a [[capture name="First"]] b [[capture name="Second"]]',
    );
    expect(capture?.name).toBe("First");
  });

  it("does not let an injected marker in the visitor's own words be parsed as HTML/markup", () => {
    // Content is taken verbatim, never interpreted.
    const { capture } = parseCaptureMarker(
      'ok [[capture name="<script>alert(1)</script>"]]',
    );
    expect(capture?.name).toBe("<script>alert(1)</script>");
  });
});

describe("parseFormMarker", () => {
  it("extracts the requested fields in the bot's order and strips the marker", () => {
    const { cleanText, fields } = parseFormMarker(
      'Happy to help — a few details?\n[[form fields="phone,name,email"]]',
    );
    expect(fields).toEqual(["phone", "name", "email"]);
    expect(cleanText).toBe("Happy to help — a few details?");
    expectNoMarkerLeak(cleanText);
  });

  it("returns fields=null when there is no marker", () => {
    const raw = "What's your budget?";
    expect(parseFormMarker(raw)).toEqual({ cleanText: raw, fields: null });
  });

  it("de-duplicates repeated fields", () => {
    const { fields } = parseFormMarker('hi [[form fields="name,name,email"]]');
    expect(fields).toEqual(["name", "email"]);
  });

  it("tolerates whitespace and casing inside the field list", () => {
    const { fields } = parseFormMarker('hi [[form fields=" Name , EMAIL "]]');
    expect(fields).toEqual(["name", "email"]);
  });

  it("drops unknown field names", () => {
    const { fields } = parseFormMarker(
      'hi [[form fields="name,creditcard,password"]]',
    );
    expect(fields).toEqual(["name"]);
  });

  it("returns fields=null but STILL strips the marker when no field survives", () => {
    const { cleanText, fields } = parseFormMarker(
      'hi [[form fields="creditcard"]]',
    );
    expect(fields).toBeNull();
    expectNoMarkerLeak(cleanText);
    expect(cleanText).toBe("hi");
  });

  it("returns fields=null but strips the marker when `fields=` is missing entirely", () => {
    const { cleanText, fields } = parseFormMarker("hi [[form please]]");
    expect(fields).toBeNull();
    expectNoMarkerLeak(cleanText);
  });

  it("ignores an unterminated form marker", () => {
    const raw = 'hi [[form fields="name"';
    expect(parseFormMarker(raw)).toEqual({ cleanText: raw, fields: null });
  });

  it("is independent of the capture marker (a form marker yields no capture)", () => {
    const raw = 'hi [[form fields="name,email"]]';
    expect(parseCaptureMarker(raw).capture).toBeNull();
  });
});
