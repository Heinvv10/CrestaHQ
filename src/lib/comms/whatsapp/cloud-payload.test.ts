import { describe, it, expect } from "vitest";
import {
  parseCloudPhoneNumberId,
  parseCloudInbound,
  parseCloudStatuses,
} from "./cloud-payload";

const textMessage = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA1",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: {
              display_phone_number: "27784356159",
              phone_number_id: "PN1",
            },
            contacts: [
              { profile: { name: "Hein" }, wa_id: "27821234567" },
            ],
            messages: [
              {
                from: "27821234567",
                id: "wamid.ABC",
                timestamp: "1756900000",
                type: "text",
                text: { body: "Happy & connected" },
              },
            ],
          },
        },
      ],
    },
  ],
};


/** Clone the fixture and swap its `messages` array, keeping the envelope. */
function withMessages(messages: unknown[]): unknown {
  const clone = structuredClone(textMessage) as typeof textMessage;
  (clone.entry[0].changes[0].value as { messages: unknown[] }).messages =
    messages;
  return clone;
}

describe("parseCloudPhoneNumberId", () => {
  it("reads the recipient number id used for routing", () => {
    expect(parseCloudPhoneNumberId(textMessage)).toBe("PN1");
  });

  it.each([null, undefined, {}, { entry: [] }, "not an object", 7])(
    "returns null for malformed payload %p",
    (p) => {
      // Meta posts to this endpoint unauthenticated until the signature check
      // runs, so the parser must never throw on junk.
      expect(parseCloudPhoneNumberId(p)).toBeNull();
    },
  );
});

describe("parseCloudInbound", () => {
  it("extracts sender, body, message id and profile name", () => {
    expect(parseCloudInbound(textMessage)).toEqual({
      fromPhone: "27821234567",
      text: "Happy & connected",
      providerMessageId: "wamid.ABC",
      profileName: "Hein",
      buttonPayload: null,
      media: null,
    });
  });

  // Shapes as Meta documents them for the two kinds of button reply.
  const withMessage = (message: Record<string, unknown>) => ({
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: "PN1" },
      messages: [{ from: "27821234567", id: "wamid.TAP", ...message }],
    } }] }],
  });

  it("reads a template quick-reply tap as a reply with its button text", () => {
    const tap = withMessage({
      type: "button",
      context: { from: "27784356159", id: "wamid.TEMPLATE" },
      button: { text: "Yes, all good", payload: "yes_all_good" },
    });
    expect(parseCloudInbound(tap)).toMatchObject({
      text: "Yes, all good",
      buttonPayload: "yes_all_good",
      providerMessageId: "wamid.TAP",
    });
  });

  it("reads an interactive button reply by its title, keeping the id", () => {
    const tap = withMessage({
      type: "interactive",
      interactive: {
        type: "button_reply",
        button_reply: { id: "no_problem", title: "No, there's a problem" },
      },
    });
    expect(parseCloudInbound(tap)).toMatchObject({
      text: "No, there's a problem",
      buttonPayload: "no_problem",
    });
  });

  it("keeps a malformed tap as an empty reply rather than dropping it", () => {
    expect(parseCloudInbound(withMessage({ type: "button", button: 7 }))).toMatchObject({
      text: "",
      buttonPayload: null,
    });
  });

  it("returns null when there are no messages", () => {
    expect(parseCloudInbound({ entry: [{ changes: [{ value: {} }] }] })).toBeNull();
  });

  it("ignores a status-only payload", () => {
    // Delivery receipts arrive on the same endpoint. Treating one as an
    // inbound would write a phantom customer message into the thread.
    const statuses = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "PN1" },
                statuses: [
                  { id: "wamid.ABC", status: "delivered", timestamp: "1756900000" },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(parseCloudInbound(statuses)).toBeNull();
  });

  it("reads the caption of a non-text message rather than dropping it", () => {
    // An image with a caption is a real customer message. Dropping it loses
    // the content AND the window-opening inbound.
    const img = withMessages([
      {
        from: "27821234567",
        id: "wamid.IMG",
        type: "image",
        image: { caption: "here it is", id: "media1" },
      },
    ]);
    expect(parseCloudInbound(img)).toMatchObject({
      text: "here it is",
      providerMessageId: "wamid.IMG",
    });
  });

  it("yields an empty body, not null, for a media message with no caption", () => {
    // Still a real inbound: it opens the 24h service window, so it must be
    // recorded even though there is no text to show.
    const img = withMessages([
      { from: "27821234567", id: "wamid.IMG", type: "image", image: { id: "m" } },
    ]);
    expect(parseCloudInbound(img)).toMatchObject({ text: "", providerMessageId: "wamid.IMG" });
  });

  it("returns null when the sender phone is missing", () => {
    const bad = withMessages([{ id: "wamid.X", type: "text", text: { body: "hi" } }]);
    expect(parseCloudInbound(bad)).toBeNull();
  });

  it("never throws on junk", () => {
    for (const p of [null, undefined, 1, "x", {}, { entry: "no" }]) {
      expect(() => parseCloudInbound(p)).not.toThrow();
    }
  });
});

describe("parseCloudStatuses", () => {
  it("extracts delivery receipts", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "PN1" },
                statuses: [
                  { id: "wamid.A", status: "delivered", timestamp: "1756900000" },
                  { id: "wamid.B", status: "read", timestamp: "1756900001" },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(parseCloudStatuses(payload)).toEqual([
      { providerMessageId: "wamid.A", status: "delivered" },
      { providerMessageId: "wamid.B", status: "read" },
    ]);
  });

  it("returns an empty list for an inbound-only payload", () => {
    expect(parseCloudStatuses(textMessage)).toEqual([]);
  });

  it("drops entries missing an id or status rather than emitting partials", () => {
    const payload = {
      entry: [{ changes: [{ value: { statuses: [{ status: "read" }, { id: "w" }] } }] }],
    };
    expect(parseCloudStatuses(payload)).toEqual([]);
  });

  it("never throws on junk", () => {
    for (const p of [null, undefined, 1, "x", {}]) {
      expect(parseCloudStatuses(p)).toEqual([]);
    }
  });
});
