import { describe, expect, it } from "vitest";
import {
  assertCreateMissingContactsUsage,
  assertWriteConfirmed,
  bodyHash,
  buildMissingContactDoc,
  isAlreadyPresent,
  isWhatsAppMessage,
  normalizeMessage,
  normalizePhoneForMatch,
  partitionByResolution,
  type ExistingMessage,
  type NormalizedGhlMessage,
} from "./ghl-wa-backfill-lib";

describe("isWhatsAppMessage", () => {
  it("matches on type/messageType/contentType, case-insensitively", () => {
    expect(isWhatsAppMessage({ type: "TYPE_WHATSAPP" })).toBe(true);
    expect(isWhatsAppMessage({ messageType: "whatsapp" })).toBe(true);
    expect(isWhatsAppMessage({ contentType: "WhatsApp" })).toBe(true);
  });

  it("rejects SMS/email/other channels", () => {
    expect(isWhatsAppMessage({ type: "TYPE_SMS" })).toBe(false);
    expect(isWhatsAppMessage({ type: "TYPE_EMAIL" })).toBe(false);
    expect(isWhatsAppMessage({})).toBe(false);
  });
});

describe("normalizeMessage", () => {
  const base = {
    id: "m1",
    contactId: "c1",
    dateAdded: "2026-09-10T08:00:00.000Z",
    direction: "inbound",
    body: "hi",
  };

  it("normalizes a well-formed row", () => {
    const n = normalizeMessage(base);
    expect(n).toEqual({
      ghlMessageId: "m1",
      ghlContactId: "c1",
      direction: "inbound",
      body: "hi",
      createdAtMs: Date.parse(base.dateAdded),
    });
  });

  it("rejects a row missing id/contactId/dateAdded", () => {
    expect(normalizeMessage({ ...base, id: undefined })).toBeNull();
    expect(normalizeMessage({ ...base, contactId: "" })).toBeNull();
    expect(normalizeMessage({ ...base, dateAdded: undefined })).toBeNull();
  });

  it("rejects an unparseable date rather than coercing it", () => {
    expect(normalizeMessage({ ...base, dateAdded: "not-a-date" })).toBeNull();
  });

  it("rejects a direction that is neither inbound nor outbound", () => {
    expect(normalizeMessage({ ...base, direction: "sideways" })).toBeNull();
  });
});

describe("bodyHash", () => {
  it("is stable and case/whitespace-insensitive", () => {
    expect(bodyHash("Hello there")).toBe(bodyHash("  hello there  "));
  });

  it("differs for different content", () => {
    expect(bodyHash("hello")).not.toBe(bodyHash("goodbye"));
  });
});

describe("isAlreadyPresent", () => {
  const candidate: NormalizedGhlMessage = {
    ghlMessageId: "ghl-1",
    ghlContactId: "c1",
    direction: "inbound",
    body: "Installation issue",
    createdAtMs: Date.parse("2026-09-10T07:11:25.869Z"),
  };

  it("matches by exact ghlMessageId", () => {
    const existing: ExistingMessage[] = [
      { ghlMessageId: "ghl-1", direction: "outbound", createdAtMs: 0, body: "irrelevant" },
    ];
    expect(isAlreadyPresent(candidate, existing)).toBe(true);
  });

  it("falls back to direction + timestamp window + body hash when no ghlMessageId is stored", () => {
    const existing: ExistingMessage[] = [
      {
        ghlMessageId: null,
        direction: "inbound",
        createdAtMs: candidate.createdAtMs + 5_000,
        body: "Installation issue",
      },
    ];
    expect(isAlreadyPresent(candidate, existing)).toBe(true);
  });

  it("does not match outside the dedupe window", () => {
    const existing: ExistingMessage[] = [
      {
        ghlMessageId: null,
        direction: "inbound",
        createdAtMs: candidate.createdAtMs + 5 * 60_000,
        body: "Installation issue",
      },
    ];
    expect(isAlreadyPresent(candidate, existing)).toBe(false);
  });

  it("does not match a different direction or body", () => {
    const wrongDirection: ExistingMessage[] = [
      { ghlMessageId: null, direction: "outbound", createdAtMs: candidate.createdAtMs, body: candidate.body },
    ];
    expect(isAlreadyPresent(candidate, wrongDirection)).toBe(false);

    const wrongBody: ExistingMessage[] = [
      { ghlMessageId: null, direction: "inbound", createdAtMs: candidate.createdAtMs, body: "totally different" },
    ];
    expect(isAlreadyPresent(candidate, wrongBody)).toBe(false);
  });

  it("reports missing when existing is empty", () => {
    expect(isAlreadyPresent(candidate, [])).toBe(false);
  });
});

describe("normalizePhoneForMatch", () => {
  it("normalizes a South African national number to E.164", () => {
    expect(normalizePhoneForMatch("082 123 4567")).toBe("+27821234567");
  });

  it("parses an international number regardless of the default country", () => {
    expect(normalizePhoneForMatch("+14155552671")).toBe("+14155552671");
  });

  it("returns null for junk or empty input rather than a guess", () => {
    expect(normalizePhoneForMatch("not a phone")).toBeNull();
    expect(normalizePhoneForMatch("")).toBeNull();
    expect(normalizePhoneForMatch(null)).toBeNull();
  });
});

describe("partitionByResolution", () => {
  it("splits resolved from unresolved without mutating input", () => {
    const input = [
      { id: "a", leadstackContactId: "ls1" },
      { id: "b", leadstackContactId: null },
      { id: "c", leadstackContactId: "ls2" },
    ];
    const { resolved, unresolved } = partitionByResolution(input);
    expect(resolved.map((m) => m.id)).toEqual(["a", "c"]);
    expect(unresolved.map((m) => m.id)).toEqual(["b"]);
    expect(input).toHaveLength(3); // unchanged
  });

  it("handles an all-resolved or all-unresolved batch", () => {
    expect(partitionByResolution([{ id: "a", leadstackContactId: "x" }]).unresolved).toEqual([]);
    expect(partitionByResolution([{ id: "a", leadstackContactId: null }]).resolved).toEqual([]);
  });
});

describe("assertCreateMissingContactsUsage", () => {
  it("is a no-op when the flag is off, regardless of unresolved count", () => {
    expect(() => assertCreateMissingContactsUsage(false, 0)).not.toThrow();
    expect(() => assertCreateMissingContactsUsage(false, 5)).not.toThrow();
  });

  it("is a no-op when the flag is on and there is something to create", () => {
    expect(() => assertCreateMissingContactsUsage(true, 5)).not.toThrow();
  });

  it("throws when the flag is on but nothing is unresolved", () => {
    expect(() => assertCreateMissingContactsUsage(true, 0)).toThrow(/nothing to create/);
  });
});

describe("buildMissingContactDoc", () => {
  it("carries agencyId/subAccountId/createdByUid and the GHL external-id stamp", () => {
    const doc = buildMissingContactDoc({
      ghlContactId: "ghl-c1",
      phone: "+27821234567",
      agencyId: "agency1",
      subAccountId: "sa1",
    });
    expect(doc).toMatchObject({
      agencyId: "agency1",
      subAccountId: "sa1",
      phone: "+27821234567",
      externalId: "ghl-c1",
      externalSource: "ghl",
      createdByUid: "import:ghl-wa-backfill",
    });
  });

  it("never writes a null phone as a string 'null'", () => {
    const doc = buildMissingContactDoc({
      ghlContactId: "ghl-c2",
      phone: null,
      agencyId: "agency1",
      subAccountId: "sa1",
    });
    expect(doc.phone).toBe("");
  });
});

describe("assertWriteConfirmed", () => {
  it("throws when --confirm is absent", () => {
    expect(() => assertWriteConfirmed(12, null)).toThrow(/requires --confirm/);
  });

  it("throws when --confirm does not match the fresh count", () => {
    expect(() => assertWriteConfirmed(12, 11)).toThrow(/does not match/);
  });

  it("passes when --confirm matches exactly", () => {
    expect(() => assertWriteConfirmed(12, 12)).not.toThrow();
  });
});
