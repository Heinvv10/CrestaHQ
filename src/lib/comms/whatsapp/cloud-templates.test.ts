import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildMetaTemplateComponents,
  mapMetaTemplateStatus,
} from "./cloud-templates";
import type { WhatsappTemplateVariable } from "@/types/whatsapp-templates";

const v = (
  position: number,
  sampleValue: string,
): WhatsappTemplateVariable => ({
  position,
  label: `v${position}`,
  sampleValue,
  source: "manual",
  mergeTag: null,
});

describe("buildMetaTemplateComponents", () => {
  it("sends the body text with no example block when there are no variables", () => {
    // Meta rejects an `example` carrying an empty body_text array.
    expect(buildMetaTemplateComponents("Your order is ready.", [])).toEqual([
      { type: "BODY", text: "Your order is ready." },
    ]);
  });

  it("attaches sample values as a single body_text row", () => {
    // Meta's shape is [[sample1, sample2]] — one row of positional samples,
    // NOT one row per variable. Getting this wrong is a submission rejection.
    expect(
      buildMetaTemplateComponents("Hi {{1}}, your {{2}} is ready.", [
        v(1, "Hein"),
        v(2, "quote"),
      ]),
    ).toEqual([
      {
        type: "BODY",
        text: "Hi {{1}}, your {{2}} is ready.",
        example: { body_text: [["Hein", "quote"]] },
      },
    ]);
  });

  it("orders samples by position, not by array order", () => {
    // The builder stores variables in edit order; Meta reads them positionally.
    // An out-of-order array would map {{1}} to the wrong sample and get the
    // template approved with the arguments transposed.
    expect(
      buildMetaTemplateComponents("{{1}} {{2}}", [v(2, "second"), v(1, "first")]),
    ).toMatchObject([
      { example: { body_text: [["first", "second"]] } },
    ]);
  });
});

describe("mapMetaTemplateStatus", () => {
  it.each([
    ["APPROVED", "approved"],
    ["PENDING", "pending"],
    ["IN_APPEAL", "pending"],
    ["PENDING_DELETION", "pending"],
    ["REJECTED", "rejected"],
    ["PAUSED", "paused"],
    ["DISABLED", "disabled"],
  ])("maps Meta %s to %s", (meta, ours) => {
    expect(mapMetaTemplateStatus(meta)).toBe(ours);
  });

  it("is case-insensitive", () => {
    expect(mapMetaTemplateStatus("approved")).toBe("approved");
  });

  it("treats an unknown status as pending rather than approved", () => {
    // Meta adds states over time. Guessing "approved" would let the send path
    // fire a template Meta has not cleared; pending just keeps polling.
    expect(mapMetaTemplateStatus("SOME_NEW_STATE")).toBe("pending");
    expect(mapMetaTemplateStatus(null)).toBe("pending");
  });
});

describe("createCloudTemplate", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const creds = { phoneNumberId: "PN", wabaId: "WABA1", accessToken: "EAAG" };

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function create(over: Record<string, unknown> = {}) {
    const { createCloudTemplate } = await import("./cloud-templates");
    return createCloudTemplate(creds, {
      name: "review_request",
      language: "en",
      category: "MARKETING",
      body: "Hi {{1}}",
      variables: [v(1, "Hein")],
      ...over,
    });
  }

  it("POSTs to the WABA id, not the phone-number id", async () => {
    // Templates belong to the business account; the phone number is the
    // sender. Swapping them 404s with an unhelpful message.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "123", status: "PENDING" }),
    });
    await create();
    expect(fetchMock.mock.calls[0][0]).toContain("/WABA1/message_templates");
    expect(fetchMock.mock.calls[0][0]).not.toContain("/PN/");
  });

  it("returns Meta's template id and mapped status", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "123", status: "APPROVED" }),
    });
    await expect(create()).resolves.toEqual({ id: "123", status: "approved" });
  });

  it("defaults to pending when Meta omits a status", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "123" }),
    });
    await expect(create()).resolves.toMatchObject({ status: "pending" });
  });

  it("throws with Meta's message so the operator sees why it was refused", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({ error: { message: "template name already exists" } }),
    });
    await expect(create()).rejects.toThrow(/already exists/);
  });

  it("never leaks the access token in the thrown error", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "bad token EAAG",
    });
    await expect(create()).rejects.toThrow(/\[redacted\]/);
  });

  it("rejects a success response with no template id", async () => {
    // Storing an empty externalId would make the registration look real while
    // being unsendable.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "PENDING" }),
    });
    await expect(create()).rejects.toThrow(/without a template id/i);
  });
});

describe("fetchCloudTemplateStatus", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const creds = { phoneNumberId: "PN", wabaId: "WABA1", accessToken: "EAAG" };

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function status(body: unknown, name = "quote") {
    const { fetchCloudTemplateStatus } = await import("./cloud-templates");
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => body });
    return fetchCloudTemplateStatus(creds, name);
  }

  it("matches the template name EXACTLY, not by prefix", async () => {
    // Meta's ?name= filter is a prefix match. Querying "quote" returns
    // "quote_reminder" too, and taking the first row would report a different
    // template's approval as this one's.
    const r = await status({
      data: [
        { name: "quote_reminder", status: "REJECTED" },
        { name: "quote", status: "APPROVED" },
      ],
    });
    expect(r).toEqual({ status: "approved", reason: null });
  });

  it("returns null when Meta does not list the name yet", async () => {
    expect(await status({ data: [] })).toBeNull();
  });

  it("carries the rejection reason through", async () => {
    expect(
      await status({
        data: [{ name: "quote", status: "REJECTED", rejected_reason: "ABUSIVE_CONTENT" }],
      }),
    ).toEqual({ status: "rejected", reason: "ABUSIVE_CONTENT" });
  });

  it("treats Meta's literal NONE reason as no reason", async () => {
    expect(
      await status({ data: [{ name: "quote", status: "APPROVED", rejected_reason: "NONE" }] }),
    ).toEqual({ status: "approved", reason: null });
  });
});
