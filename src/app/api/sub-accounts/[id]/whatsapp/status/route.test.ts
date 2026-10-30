import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/google-oauth-harness")).adminMock());

import {
  ORIGINAL_ENV,
  OTHER_SUB,
  SUB,
  call,
  json,
  resetWaSettings,
  seedScenario,
  state,
  stubGraph,
} from "@/test/wa-settings-harness";
import { whatsappCloudSecretPath } from "@/types/whatsapp-cloud";
import { GET } from "./route";

/** GET /whatsapp/status — header data; the tenancy guard runs for real. */

beforeEach(() => resetWaSettings());
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe("who may read", () => {
  it.each(["uid_admin", "uid_member", "uid_collab"])("%s (any active member) gets the header", async (uid) => {
    const { status, body } = await json(call(GET, { id: SUB }, { uid }));
    expect(status).toBe(200);
    expect(body.phone).toMatchObject({ qualityRating: "GREEN", verifiedName: "E2E Fixture Fibre" });
    expect(body.meta).toEqual({ displayPhoneNumber: "+27 60 000 0000", verifiedName: "E2E Fixture Fibre", phoneNumberId: "pn_fixture" });
    expect(body.quality).toBeNull();
    expect(body.openAlert).toBeNull();
  });

  it("401s without a caller and 403s an admin of ANOTHER sub-account", async () => {
    expect((await call(GET, { id: SUB }, { uid: null })).status).toBe(401);
    expect((await call(GET, { id: SUB }, { uid: "uid_other_admin" })).status).toBe(403);
  });

  it("403s when the agency's WhatsApp gate is off", async () => {
    resetWaSettings({ gateOn: false });
    const { status, body } = await json(call(GET, { id: SUB }));
    expect(status).toBe(403);
    expect(body.error).toMatch(/isn't enabled/);
  });
});

describe("the provider is the path's sub-account's", () => {
  it("409 not_connected in graph mode when THIS sub-account has no Cloud secret", async () => {
    resetWaSettings({ mode: "graph" });
    state.docs.set(whatsappCloudSecretPath(OTHER_SUB), { phoneNumberId: "pn_other", wabaId: "w", accessToken: "t" });
    const { status, body } = await json(call(GET, { id: SUB }));
    expect(status).toBe(409);
    expect(body).toEqual({ error: "not_connected" });
  });

  it("409 not_connected in fake mode too, when the sub-account carries no Cloud number", async () => {
    const sub = state.docs.get(`subAccounts/${SUB}`)!;
    state.docs.set(`subAccounts/${SUB}`, { ...sub, whatsappCloudMeta: null });
    const { status, body } = await json(call(GET, { id: SUB }));
    expect(status).toBe(409);
    expect(body).toEqual({ error: "not_connected" });
    expect(state.reads).not.toContain(`subAccounts/${SUB}/private/whatsappFakeScenario`);
  });

  it("graph mode calls Meta with THIS sub-account's phone-number id and token", async () => {
    resetWaSettings({ mode: "graph" });
    state.docs.set(whatsappCloudSecretPath(SUB), { phoneNumberId: "pn_mine", wabaId: "w", accessToken: "tok_mine" });
    state.docs.set(whatsappCloudSecretPath(OTHER_SUB), { phoneNumberId: "pn_other", wabaId: "w", accessToken: "tok_other" });
    const fetchSpy = stubGraph([{ display_phone_number: "+27 1", verified_name: "V", quality_rating: "YELLOW", name_status: "APPROVED", status: "CONNECTED" }]);
    const { status, body } = await json(call(GET, { id: SUB }));
    expect(status).toBe(200);
    expect(body.phone).toMatchObject({ qualityRating: "YELLOW" });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/pn_mine?fields=");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok_mine");
    expect(JSON.stringify(body)).not.toContain("tok_mine");
  });

  it("relays a Meta refusal as its status with the token redacted", async () => {
    resetWaSettings({ mode: "graph" });
    state.docs.set(whatsappCloudSecretPath(SUB), { phoneNumberId: "pn_mine", wabaId: "w", accessToken: "tok_mine" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: "Invalid OAuth access token tok_mine", code: 190 } }), { status: 401 })),
    );
    const { status, body } = await json(call(GET, { id: SUB }));
    expect(status).toBe(401);
    expect(String(body.error)).toContain("[redacted]");
    expect(String(body.error)).not.toContain("tok_mine");
  });

  it("returns the stored quality reading when the poll has run", async () => {
    const sub = state.docs.get(`subAccounts/${SUB}`)!;
    state.docs.set(`subAccounts/${SUB}`, {
      ...sub,
      whatsappCloudMeta: { ...(sub.whatsappCloudMeta as object), quality: { rating: "YELLOW", nameStatus: "APPROVED", status: "CONNECTED", checkedAt: "t1", changedAt: "t0" } },
    });
    seedScenario({});
    const { body } = await json(call(GET, { id: SUB }));
    expect(body.quality).toMatchObject({ rating: "YELLOW", changedAt: "t0" });
  });
});

describe("openAlert", () => {
  it("is the newest UNRESOLVED alert for THIS sub-account, or null", async () => {
    const col = `subAccounts/${SUB}/whatsappQualityAlerts`;
    state.docs.set(`${col}/old`, { from: "GREEN", to: "RED", createdAt: new Date("2026-09-01T00:00:00Z"), resolvedAt: null });
    state.docs.set(`${col}/new`, { from: "GREEN", to: "YELLOW", createdAt: new Date("2026-09-10T00:00:00Z"), resolvedAt: null });
    state.docs.set(`${col}/done`, { from: "GREEN", to: "RED", createdAt: new Date("2026-09-11T00:00:00Z"), resolvedAt: new Date() });
    state.docs.set(`subAccounts/${OTHER_SUB}/whatsappQualityAlerts/x`, { from: "GREEN", to: "RED", createdAt: new Date("2026-09-12T00:00:00Z"), resolvedAt: null });
    const { body } = await json(call(GET, { id: SUB }));
    expect(body.openAlert).toEqual({ from: "GREEN", to: "YELLOW", createdAt: "2026-09-10T00:00:00.000Z" });
  });
});
