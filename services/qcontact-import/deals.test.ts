import { describe, expect, it, vi } from "vitest";
import { leadstackDealEnsurer, type DealEnv } from "./deals.ts";

const env: DealEnv = {
  LEADSTACK_API_URL: "https://crm.test",
  LEADSTACK_API_KEY: "sk_test",
  QCONTACT_DEAL_PIPELINE_ID: "install-requests",
  QCONTACT_DEAL_STAGE: "new_request",
  QCONTACT_DEAL_OWNER_UID: undefined,
};

function listResponse(deals: { pipeline_id: string }[]) {
  return new Response(JSON.stringify({ object: "list", data: deals, has_more: false }), { status: 200 });
}

describe("leadstackDealEnsurer", () => {
  it("creates a deal with pipeline/stage/title/value/currency and a per-case idempotency key when none exists", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(new Response('{"deal":{"id":"d1"}}', { status: 201 }));
    const r = await leadstackDealEnsurer(env, fetchImpl as unknown as typeof fetch)({
      contactId: "c1", caseId: 42, title: "Install request — Jane Doe (FT42)",
    });
    expect(r).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const [listUrl, listInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(listUrl).toBe("https://crm.test/api/v1/deals?contact_id=c1");
    expect(listInit.headers).toMatchObject({ Authorization: "Bearer sk_test" });

    const [createUrl, createInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(createUrl).toBe("https://crm.test/api/v1/deals");
    expect(createInit.method).toBe("POST");
    expect(createInit.headers).toMatchObject({
      Authorization: "Bearer sk_test",
      "Idempotency-Key": "qcontact-deal-42",
    });
    expect(JSON.parse(createInit.body as string)).toEqual({
      contact_id: "c1",
      pipeline_id: "install-requests",
      stage: "new_request",
      title: "Install request — Jane Doe (FT42)",
      value: 0,
      currency: "ZAR",
    });
  });

  it("does nothing when the contact already has a deal in the configured pipeline", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(listResponse([{ pipeline_id: "install-requests" }]));
    const r = await leadstackDealEnsurer(env, fetchImpl as unknown as typeof fetch)({
      contactId: "c1", caseId: 42, title: "t",
    });
    expect(r).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a deal in a DIFFERENT pipeline does not count — still creates one in the configured pipeline", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(listResponse([{ pipeline_id: "some-other-pipeline" }]))
      .mockResolvedValueOnce(new Response('{"deal":{"id":"d1"}}', { status: 201 }));
    const r = await leadstackDealEnsurer(env, fetchImpl as unknown as typeof fetch)({
      contactId: "c1", caseId: 42, title: "t",
    });
    expect(r).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports a failed list call as an error without attempting to create", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("nope", { status: 500 }));
    const r = await leadstackDealEnsurer(env, fetchImpl as unknown as typeof fetch)({
      contactId: "c1", caseId: 42, title: "t",
    });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("HTTP 500 listing deals") });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends assigned_to_uid only when QCONTACT_DEAL_OWNER_UID is set", async () => {
    const withOwner: DealEnv = { ...env, QCONTACT_DEAL_OWNER_UID: "uid_123" };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(new Response('{"deal":{"id":"d1"}}', { status: 201 }));
    await leadstackDealEnsurer(withOwner, fetchImpl as unknown as typeof fetch)({
      contactId: "c1", caseId: 42, title: "t",
    });
    const [, createInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(createInit.body as string)).toMatchObject({ assigned_to_uid: "uid_123" });
  });

  it("omits assigned_to_uid when QCONTACT_DEAL_OWNER_UID is unset", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(new Response('{"deal":{"id":"d1"}}', { status: 201 }));
    await leadstackDealEnsurer(env, fetchImpl as unknown as typeof fetch)({
      contactId: "c1", caseId: 42, title: "t",
    });
    const [, createInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(createInit.body as string)).not.toHaveProperty("assigned_to_uid");
  });

  it("reports a failed create call as an error", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(new Response('{"error":"invalid_body"}', { status: 400 }));
    const r = await leadstackDealEnsurer(env, fetchImpl as unknown as typeof fetch)({
      contactId: "c1", caseId: 42, title: "t",
    });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("HTTP 400 creating deal") });
  });
});
