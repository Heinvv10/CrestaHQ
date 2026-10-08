import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * A mystery-shop call through the REAL placeContactCall → createOutboundCall
 * → Vapi request: only `fetch` is faked, so the body Vapi would receive is
 * the one asserted. The shop id must travel as call metadata (the LLM
 * webhook's prompt switch and the end-of-call settle read it), the enquiry
 * as the first message, and the call capped at 120 s.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const { mem } = await import("@/test/gbp-sync-store");
const { placeContactCall } = await import("./voice-call");

const fetchMock = vi.fn();
const VOICE = { vapiAssistantId: "asst_1", vapiPhoneNumberId: "pn_1", outboundFirstMessage: "SALES OPENER" } as never;

beforeEach(() => {
  mem.clear();
  vi.stubEnv("VAPI_API_KEY", "test-key");
  fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ id: "call_1" }), { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const place = (mysteryShop?: { id: string; firstMessage: string; maxDurationSeconds: number }) =>
  placeContactCall({
    contact: { agencyId: "ag1", subAccountId: "sa1" },
    contactId: "c1",
    uid: "u1",
    voice: VOICE,
    customerNumber: "+27821234567",
    ...(mysteryShop ? { mysteryShop } : {}),
  });

it("sends the shop id as call metadata, the enquiry as the first message, and a 120 s cap", async () => {
  expect(await place({ id: "shop_9", firstMessage: "Do you do plumbing in Gqeberha?", maxDurationSeconds: 120 })).toEqual({
    ok: true, callId: "call_1",
  });
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toMatch(/\/call$/);
  const body = JSON.parse(init.body as string);
  expect(body.metadata).toEqual({ direction: "outbound", contactId: "c1", mysteryShopId: "shop_9" });
  expect(body.assistantOverrides).toEqual({ firstMessage: "Do you do plumbing in Gqeberha?", maxDurationSeconds: 120 });
  expect(body.customer).toEqual({ number: "+27821234567" });
});

it("an ordinary call carries no shop id, the sales opener and no cap", async () => {
  await place();
  const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
  expect(body.metadata).toEqual({ direction: "outbound", contactId: "c1" });
  expect(body.assistantOverrides).toEqual({ firstMessage: "SALES OPENER" });
});

it("a Vapi rejection placed nothing; a network error or a 5xx may have placed the call", async () => {
  fetchMock.mockResolvedValueOnce(new Response('{"message":"bad number"}', { status: 400 }));
  expect(await place()).toMatchObject({ ok: false, uncertain: false });
  fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
  expect(await place()).toMatchObject({ ok: false, uncertain: true });
  fetchMock.mockResolvedValueOnce(new Response('{"message":"upstream"}', { status: 502 }));
  expect(await place()).toMatchObject({ ok: false, uncertain: true });
  // A 5xx with no body is still a 5xx: the call may exist.
  fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }));
  expect(await place()).toMatchObject({ ok: false, uncertain: true });
  fetchMock.mockResolvedValueOnce(new Response("", { status: 422 }));
  expect(await place()).toMatchObject({ ok: false, uncertain: false });
});
