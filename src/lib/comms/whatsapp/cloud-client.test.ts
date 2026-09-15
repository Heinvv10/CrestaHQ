import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { normalizeWaPhone, buildCloudMessageBody } from "./cloud-client";

describe("normalizeWaPhone", () => {
  it("strips the leading + Meta does not want", () => {
    expect(normalizeWaPhone("+27784356159")).toBe("27784356159");
  });

  it("strips spaces, dashes and parentheses from an operator-typed number", () => {
    expect(normalizeWaPhone("+27 (78) 435-6159")).toBe("27784356159");
  });

  it("strips a twilio-style whatsapp: prefix", () => {
    // Numbers reaching this rail may have been stored by the Twilio path,
    // which addresses endpoints as `whatsapp:+E164`. Sending that verbatim to
    // Meta is an invalid-recipient error.
    expect(normalizeWaPhone("whatsapp:+27784356159")).toBe("27784356159");
  });

  it("leaves an already-bare number alone", () => {
    expect(normalizeWaPhone("27784356159")).toBe("27784356159");
  });
});

describe("buildCloudMessageBody", () => {
  it("builds a text message for free-form mode", () => {
    expect(
      buildCloudMessageBody({ mode: "text" }, "+27784356159", "hi there", null),
    ).toEqual({
      messaging_product: "whatsapp",
      to: "27784356159",
      type: "text",
      text: { body: "hi there" },
    });
  });

  it("builds a template message with name, language and components", () => {
    const body = buildCloudMessageBody(
      { mode: "template" },
      "+27784356159",
      "ignored",
      {
        name: "velocity_review_request_v2",
        language: "en",
        components: [
          { type: "body", parameters: [{ type: "text", text: "Hein" }] },
        ],
      },
    );
    expect(body).toEqual({
      messaging_product: "whatsapp",
      to: "27784356159",
      type: "template",
      template: {
        name: "velocity_review_request_v2",
        language: { code: "en" },
        components: [
          { type: "body", parameters: [{ type: "text", text: "Hein" }] },
        ],
      },
    });
  });

  it("falls back to text when template mode is asked for without a template", () => {
    // Defensive: the decision layer should never produce this pairing. If it
    // does, sending text is strictly safer than sending `template: undefined`,
    // which Meta answers with a 400 the operator cannot act on.
    const body = buildCloudMessageBody(
      { mode: "template" },
      "+27784356159",
      "hi",
      null,
    );
    expect(body.type).toBe("text");
  });
});

describe("sendWhatsappCloud", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const creds = {
    phoneNumberId: "111",
    wabaId: "222",
    accessToken: "EAAG",
  };

  const baseOpts = {
    subAccountId: "sa_1",
    to: "+27784356159",
    message: "hello",
    lastInboundAt: new Date(Date.now() - 3600_000),
    template: null,
    provider: "cloud" as const,
    now: new Date(),
  };

  async function send(overrides: Record<string, unknown> = {}) {
    const { sendWhatsappCloud } = await import("./cloud-client");
    return sendWhatsappCloud({ ...baseOpts, ...overrides, creds });
  }

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("NODE_ENV", "development");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function ok(body: unknown) {
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }

  it("posts to the phone-number id, not the WABA id", async () => {
    // Authorising a send with the WABA id yields an opaque 404. Pinning the
    // URL here is the cheapest guard against swapping two adjacent ids.
    fetchMock.mockResolvedValue(ok({ messages: [{ id: "wamid.X" }] }));
    await send();
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/111/messages");
    expect(url).not.toContain("/222/");
  });

  it("returns the provider message id on success", async () => {
    fetchMock.mockResolvedValue(ok({ messages: [{ id: "wamid.X" }] }));
    await expect(send()).resolves.toEqual({ ok: true, messageId: "wamid.X" });
  });

  it("refuses outside the window with no approved template WITHOUT calling Meta", async () => {
    // The refusal must happen before the HTTP call: a send attempted anyway is
    // both billed and a quality-rating hit.
    const r = await send({ lastInboundAt: new Date(Date.now() - 30 * 3600_000) });
    expect(r.ok).toBe(false);
    expect(r.providerOutcome).toBe("DEFINITELY_REJECTED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends free-form inside the window even when an approved template exists", async () => {
    fetchMock.mockResolvedValue(ok({ messages: [{ id: "wamid.X" }] }));
    await send({
      template: { name: "t", language: "en", components: [], approved: true },
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.type).toBe("text");
  });

  it("sends the template outside the window when it is approved", async () => {
    fetchMock.mockResolvedValue(ok({ messages: [{ id: "wamid.X" }] }));
    await send({
      lastInboundAt: new Date(Date.now() - 30 * 3600_000),
      template: { name: "t", language: "en", components: [], approved: true },
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.type).toBe("template");
  });

  it("never sends an unapproved template", async () => {
    // Meta rejects it, but it also burns a send attempt and confuses the
    // operator. Treat unapproved as absent.
    const r = await send({
      lastInboundAt: new Date(Date.now() - 30 * 3600_000),
      template: { name: "t", language: "en", components: [], approved: false },
    });
    expect(r.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks a 4xx as definitively rejected so nothing retries it", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "bad recipient",
    });
    const r = await send();
    expect(r.ok).toBe(false);
    expect(r.providerOutcome).toBe("DEFINITELY_REJECTED");
  });

  it("marks a 429 as ambiguous so a retry stays possible", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => "slow down" });
    expect((await send()).providerOutcome).toBe("AMBIGUOUS");
  });

  it("marks a 5xx as ambiguous", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => "oops" });
    expect((await send()).providerOutcome).toBe("AMBIGUOUS");
  });

  it("treats a 200 with no message id as ambiguous rather than success", async () => {
    // Claiming success without an id would write a message row with no
    // provider reference, so delivery receipts could never be matched to it.
    fetchMock.mockResolvedValue(ok({ messages: [] }));
    const r = await send();
    expect(r.ok).toBe(false);
    expect(r.providerOutcome).toBe("AMBIGUOUS");
  });

  it("treats a network throw as ambiguous, not rejected", async () => {
    // The request may have reached Meta. Calling this DEFINITELY_REJECTED
    // would invite a retry that double-messages the customer.
    fetchMock.mockRejectedValue(new Error("socket hang up"));
    const r = await send();
    expect(r.ok).toBe(false);
    expect(r.providerOutcome).toBe("AMBIGUOUS");
  });

  it("never puts the access token in the returned error string", async () => {
    // Send results are surfaced to operators and written to logs.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "invalid token EAAG",
    });
    const r = await send();
    expect(r.error).not.toContain("EAAG");
  });

  const media = { filename: "a.png", contentType: "image/png", dataBase64: "AAEC" };

  it("refuses media outside the window even with an approved template, WITHOUT calling Meta", async () => {
    // A template cannot carry a file. Sending the template alone would drop
    // the file silently — the one outcome nobody in the thread can detect.
    const r = await send({
      lastInboundAt: new Date(Date.now() - 30 * 3600_000),
      template: { name: "t", language: "en", components: [], approved: true },
      media,
    });
    expect(r.ok).toBe(false);
    expect(r.providerErrorCode).toBe("media_invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses media alongside in-window buttons, WITHOUT calling Meta", async () => {
    const r = await send({
      interactive: { type: "button", body: { text: "x" }, action: { buttons: [] } },
      media,
    });
    expect(r.ok).toBe(false);
    expect(r.providerErrorCode).toBe("media_invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never puts the access token in an upload error string", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "invalid token EAAG",
    });
    const r = await send({ media });
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain("EAAG");
  });
});
