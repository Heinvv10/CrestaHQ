import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGraphSettingsProvider,
  mapQualityRating,
  parseMessageLink,
  parsePhoneStatus,
  parseProfile,
  validatePrefilledMessage,
  validateProfileInput,
} from "./graph";
import { WaSettingsError } from "./types";

/**
 * The real arm of the settings seam, against the responses recorded from a
 * read-only probe of Velocity's number (docs/parity/sp15.md) and a stubbed
 * fetch that records every request. Meta is never called.
 */

// ── Recorded fixtures (verbatim from sp15.md) ────────────────────────────
const PHONE_FIXTURE = {
  display_phone_number: "+27 67 147 7116",
  verified_name: "Velocity Fibre",
  quality_rating: "GREEN",
  name_status: "APPROVED",
  status: "CONNECTED",
  code_verification_status: "VERIFIED",
  platform_type: "CLOUD_API",
  throughput: { level: "STANDARD" },
  id: "1276735168846891",
};
const PROFILE_FIXTURE = { data: [{ vertical: "UNDEFINED", messaging_product: "whatsapp" }] };
const LINKS_FIXTURE = { data: [] };
const APP_FIXTURE = { id: "1451493066882070", name: "CrestaHQ Messaging" };

describe("parsers", () => {
  it("maps the recorded phone-number node", () => {
    expect(parsePhoneStatus(PHONE_FIXTURE)).toEqual({
      displayPhoneNumber: "+27 67 147 7116",
      verifiedName: "Velocity Fibre",
      qualityRating: "GREEN",
      nameStatus: "APPROVED",
      status: "CONNECTED",
    });
  });

  it("treats every unrecognised quality rating as UNKNOWN and never throws", () => {
    for (const raw of ["NA", "", null, undefined, 42, {}, "green "]) {
      expect(mapQualityRating(raw)).toBe("UNKNOWN");
    }
    expect(mapQualityRating("yellow")).toBe("YELLOW");
    expect(mapQualityRating("RED")).toBe("RED");
  });

  it("maps the recorded (empty) profile — absent fields become empty strings", () => {
    expect(parseProfile(PROFILE_FIXTURE)).toEqual({
      about: "",
      address: "",
      description: "",
      email: "",
      websites: [],
      vertical: "UNDEFINED",
      profilePictureUrl: null,
    });
  });

  it("maps a filled profile", () => {
    expect(
      parseProfile({
        data: [
          {
            about: "Fibre to the home",
            address: "1 Fixture Road",
            description: "d",
            email: "hi@example.com",
            profile_picture_url: "https://pps.whatsapp.net/x",
            websites: ["https://example.com", 7],
            vertical: "PROF_SERVICES",
          },
        ],
      }),
    ).toEqual({
      about: "Fibre to the home",
      address: "1 Fixture Road",
      description: "d",
      email: "hi@example.com",
      websites: ["https://example.com"],
      vertical: "PROF_SERVICES",
      profilePictureUrl: "https://pps.whatsapp.net/x",
    });
  });

  it("maps a message link, with a missing QR as null", () => {
    expect(
      parseMessageLink({
        code: "ABC123",
        prefilled_message: "Hi",
        deep_link_url: "https://wa.me/message/ABC123",
      }),
    ).toEqual({ code: "ABC123", prefilledMessage: "Hi", deepLinkUrl: "https://wa.me/message/ABC123", qrImageUrl: null });
  });
});

describe("validateProfileInput", () => {
  const good = {
    about: " Fibre ",
    address: "1 Road",
    description: "Desc",
    email: "hi@example.com",
    websites: ["https://a.example", " http://b.example "],
    vertical: "RETAIL",
  };

  it("accepts a full form, trimmed", () => {
    expect(validateProfileInput(good)).toEqual({
      ok: true,
      value: { ...good, about: "Fibre", websites: ["https://a.example", "http://b.example"] },
    });
  });

  it("accepts an empty form (every field cleared) with vertical defaulting to UNDEFINED", () => {
    expect(validateProfileInput({})).toEqual({
      ok: true,
      value: { about: "", address: "", description: "", email: "", websites: [], vertical: "UNDEFINED" },
    });
  });

  it.each([
    ["about", 139],
    ["address", 256],
    ["description", 512],
    ["email", 128],
  ] as const)("enforces the %s limit of %i", (field, limit) => {
    const at = { ...good, email: "a@b.co", [field]: "x".repeat(limit) };
    const over = { ...good, email: "a@b.co", [field]: "x".repeat(limit + 1) };
    if (field === "email") {
      at.email = `${"x".repeat(limit - 5)}@b.co`;
      over.email = `${"x".repeat(limit - 4)}@b.co`;
    }
    expect(validateProfileInput(at).ok).toBe(true);
    const res = validateProfileInput(over);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(field);
  });

  it("refuses more than two websites, a non-http(s) one, and one over 256 chars", () => {
    expect(validateProfileInput({ ...good, websites: ["https://a.x", "https://b.x", "https://c.x"] }).ok).toBe(false);
    expect(validateProfileInput({ ...good, websites: ["ftp://a.x"] }).ok).toBe(false);
    expect(validateProfileInput({ ...good, websites: ["javascript:alert(1)"] }).ok).toBe(false);
    expect(validateProfileInput({ ...good, websites: [`https://${"a".repeat(250)}.x`] }).ok).toBe(false);
    expect(validateProfileInput({ ...good, websites: "https://a.x" }).ok).toBe(false);
  });

  it("refuses a vertical outside Meta's enum and a malformed email", () => {
    expect(validateProfileInput({ ...good, vertical: "PLUMBING" }).ok).toBe(false);
    expect(validateProfileInput({ ...good, email: "not-an-email" }).ok).toBe(false);
    expect(validateProfileInput(null).ok).toBe(false);
    expect(validateProfileInput({ ...good, about: 5 }).ok).toBe(false);
  });
});

describe("validatePrefilledMessage", () => {
  it("requires text, trims it and caps it at 140", () => {
    expect(validatePrefilledMessage("  Hi there ")).toEqual({ ok: true, value: "Hi there" });
    expect(validatePrefilledMessage("x".repeat(140)).ok).toBe(true);
    expect(validatePrefilledMessage("x".repeat(141)).ok).toBe(false);
    expect(validatePrefilledMessage("").ok).toBe(false);
    expect(validatePrefilledMessage("   ").ok).toBe(false);
    expect(validatePrefilledMessage(undefined).ok).toBe(false);
  });
});

// ── The provider against a stubbed fetch ────────────────────────────────
const TOKEN = "EAAB-secret-system-user-token";
const CREDS = { phoneNumberId: "1276735168846891", wabaId: "waba_1", accessToken: TOKEN };
const BASE = "https://graph.facebook.com/v23.0";

type Recorded = { url: string; method: string; headers: Record<string, string>; body: unknown };
let requests: Recorded[];
let responses: Array<{ status?: number; body: unknown }>;

function fetchStub(): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    let body: unknown = init?.body ?? null;
    if (typeof body === "string") body = JSON.parse(body);
    else if (body instanceof Blob) body = new Uint8Array(await body.arrayBuffer());
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      body,
    });
    const next = responses.shift() ?? { body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const provider = () => createGraphSettingsProvider(CREDS, fetchStub());

beforeEach(() => {
  requests = [];
  responses = [];
  delete process.env.WHATSAPP_GRAPH_VERSION;
});
afterEach(() => vi.restoreAllMocks());

describe("Graph provider requests", () => {
  it("getPhoneStatus: GET the node with the fields and a Bearer token", async () => {
    responses.push({ body: PHONE_FIXTURE });
    const status = await provider().getPhoneStatus();
    expect(status.qualityRating).toBe("GREEN");
    expect(requests).toEqual([
      expect.objectContaining({
        url: `${BASE}/1276735168846891?fields=display_phone_number,verified_name,quality_rating,name_status,status`,
        method: "GET",
        headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}` }),
      }),
    ]);
  });

  it("honours WHATSAPP_GRAPH_VERSION", async () => {
    process.env.WHATSAPP_GRAPH_VERSION = "v24.0";
    responses.push({ body: PROFILE_FIXTURE });
    await provider().getProfile();
    expect(requests[0].url).toBe(
      `https://graph.facebook.com/v24.0/1276735168846891/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites,vertical`,
    );
  });

  it("updateProfile: POSTs the full form with messaging_product", async () => {
    responses.push({ body: { success: true } });
    const input = { about: "A", address: "", description: "D", email: "", websites: ["https://a.x"], vertical: "RETAIL" };
    await provider().updateProfile(input);
    expect(requests).toEqual([
      expect.objectContaining({
        url: `${BASE}/1276735168846891/whatsapp_business_profile`,
        method: "POST",
        headers: expect.objectContaining({ "content-type": "application/json", authorization: `Bearer ${TOKEN}` }),
        body: { messaging_product: "whatsapp", ...input },
      }),
    ]);
  });

  it("listMessageLinks: GET message_qrdls with the fields; empty data → []", async () => {
    responses.push({ body: LINKS_FIXTURE });
    expect(await provider().listMessageLinks()).toEqual([]);
    expect(requests[0].url).toBe(`${BASE}/1276735168846891/message_qrdls?fields=code,prefilled_message,deep_link_url,qr_image_url`);
  });

  it("createMessageLink: POSTs the text and asks for an SVG QR", async () => {
    responses.push({
      body: { code: "K1", prefilled_message: "Hi", deep_link_url: "https://wa.me/message/K1", qr_image_url: "https://q/K1.svg" },
    });
    const link = await provider().createMessageLink("Hi");
    expect(link).toEqual({ code: "K1", prefilledMessage: "Hi", deepLinkUrl: "https://wa.me/message/K1", qrImageUrl: "https://q/K1.svg" });
    expect(requests[0]).toMatchObject({
      url: `${BASE}/1276735168846891/message_qrdls`,
      method: "POST",
      body: { prefilled_message: "Hi", generate_qr_image: "SVG" },
    });
  });

  it("createMessageLink: a reply without a code is an error, not a link", async () => {
    responses.push({ body: { success: true } });
    await expect(provider().createMessageLink("Hi")).rejects.toBeInstanceOf(WaSettingsError);
  });

  it("deleteMessageLink: DELETE message_qrdls/{code}", async () => {
    responses.push({ body: { success: true } });
    await provider().deleteMessageLink("K1");
    expect(requests[0]).toMatchObject({ url: `${BASE}/1276735168846891/message_qrdls/K1`, method: "DELETE" });
  });

  it("uploadProfilePhoto: app id → upload session → bytes at offset 0 with OAuth → handle → profile POST", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    responses.push({ body: APP_FIXTURE });
    responses.push({ body: { id: "upload:MTphdHRhY2htZW50Og" } });
    responses.push({ body: { h: "2:c2FtcGxl:handle" } });
    responses.push({ body: { success: true } });
    await provider().uploadProfilePhoto(bytes, "image/jpeg");

    expect(requests.map((r) => [r.method, r.url])).toEqual([
      ["GET", `${BASE}/app?fields=id`],
      ["POST", `${BASE}/1451493066882070/uploads?file_length=7&file_type=image%2Fjpeg`],
      ["POST", `${BASE}/upload:MTphdHRhY2htZW50Og`],
      ["POST", `${BASE}/1276735168846891/whatsapp_business_profile`],
    ]);
    // Token never in a query string.
    for (const r of requests) expect(r.url).not.toContain(TOKEN);
    expect(requests[1].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(requests[2].headers).toMatchObject({ authorization: `OAuth ${TOKEN}`, file_offset: "0", "content-type": "image/jpeg" });
    expect(requests[2].body).toEqual(bytes);
    expect(requests[3].body).toEqual({ messaging_product: "whatsapp", profile_picture_handle: "2:c2FtcGxl:handle" });
  });

  it("uploadProfilePhoto: stops at the first step that returns no id/handle", async () => {
    responses.push({ body: APP_FIXTURE });
    responses.push({ body: { id: "not-an-upload-session" } });
    await expect(provider().uploadProfilePhoto(new Uint8Array([1]), "image/png")).rejects.toBeInstanceOf(WaSettingsError);
    expect(requests).toHaveLength(2);
  });
});

describe("Graph provider errors", () => {
  it("relays Meta's status and message, with the token redacted", async () => {
    responses.push({
      status: 400,
      body: {
        error: {
          message: `Invalid OAuth access token ${TOKEN} - Cannot parse access token`,
          type: "OAuthException",
          code: 190,
          fbtrace_id: "A1",
        },
      },
    });
    const err = await provider().getPhoneStatus().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WaSettingsError);
    expect((err as WaSettingsError).status).toBe(400);
    expect((err as WaSettingsError).message).toContain("Cannot parse access token");
    expect((err as WaSettingsError).message).not.toContain(TOKEN);
    expect((err as WaSettingsError).message).toContain("[redacted]");
  });

  it("prefers error_user_msg when Meta provides one", async () => {
    responses.push({ status: 400, body: { error: { message: "(#100) Param about is too long", error_user_msg: "About is too long." } } });
    await expect(provider().updateProfile({ about: "", address: "", description: "", email: "", websites: [], vertical: "UNDEFINED" }))
      .rejects.toThrow("About is too long.");
  });

  it("turns a network failure into a 502 with a fixed message", async () => {
    const failing = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED ${TOKEN}`);
    }) as unknown as typeof fetch;
    const err = await createGraphSettingsProvider(CREDS, failing).getProfile().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WaSettingsError);
    expect((err as WaSettingsError).status).toBe(502);
    expect((err as WaSettingsError).message).not.toContain(TOKEN);
  });

  it("passes a 15s timeout signal on every call", async () => {
    responses.push({ body: PHONE_FIXTURE });
    const stub = fetchStub();
    await createGraphSettingsProvider(CREDS, stub).getPhoneStatus();
    const init = (stub as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
