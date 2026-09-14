import { describe, expect, it, vi } from "vitest";
import { leadstackStageSyncer, statusToStageId, type StageSyncEnv } from "./stage-sync.ts";

const env: StageSyncEnv = {
  LEADSTACK_API_URL: "https://crm.test",
  LEADSTACK_API_KEY: "sk_test",
  QCONTACT_DEAL_PIPELINE_ID: "install-requests",
};

function listResponse(deals: { id: string; pipeline_id: string; stage: string }[]) {
  return new Response(JSON.stringify({ object: "list", data: deals, has_more: false }), { status: 200 });
}

describe("statusToStageId", () => {
  it("maps every known QContact status to its stage id", () => {
    expect(statusToStageId("New")).toBe("new");
    expect(statusToStageId("Assigned")).toBe("assigned");
    expect(statusToStageId("Upcoming")).toBe("upcoming");
    expect(statusToStageId("Pending Customer")).toBe("pending_customer");
    expect(statusToStageId("In Progress")).toBe("in_progress");
    expect(statusToStageId("Escalated")).toBe("escalated");
    expect(statusToStageId("PON Not Live")).toBe("pon_not_live");
    expect(statusToStageId("Solved")).toBe("solved");
    expect(statusToStageId("Solved - No Response")).toBe("solved_no_response");
    expect(statusToStageId("Unsolved - No Response")).toBe("unsolved_no_response");
  });

  it("accepts both the en-dash and hyphen forms of 'Closed – No response'", () => {
    expect(statusToStageId("Closed – No response")).toBe("closed_no_response");
    expect(statusToStageId("Closed - No response")).toBe("closed_no_response");
  });

  it("leaves an unknown status unmapped rather than guessing", () => {
    expect(statusToStageId("Some New Status QContact Invented")).toBeUndefined();
    expect(statusToStageId(null)).toBeUndefined();
  });
});

describe("leadstackStageSyncer", () => {
  it("moves the deal when its stage differs from the mapped status", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(listResponse([{ id: "d1", pipeline_id: "install-requests", stage: "new_request" }]))
      .mockResolvedValueOnce(new Response('{"deal":{"id":"d1"}}', { status: 200 }));
    const r = await leadstackStageSyncer(env, fetchImpl as unknown as typeof fetch)({
      contactId: "c1", status: "Assigned",
    });
    expect(r).toEqual({ ok: true, action: "synced" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const [listUrl] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(listUrl).toBe("https://crm.test/api/v1/deals?contact_id=c1");

    const [patchUrl, patchInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(patchUrl).toBe("https://crm.test/api/v1/deals/d1");
    expect(patchInit.method).toBe("PATCH");
    expect(patchInit.headers).toMatchObject({ Authorization: "Bearer sk_test" });
    expect(JSON.parse(patchInit.body as string)).toEqual({ stage: "assigned" });
  });

  it("does not PATCH when the deal's stage already matches", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(listResponse([{ id: "d1", pipeline_id: "install-requests", stage: "assigned" }]));
    const r = await leadstackStageSyncer(env, fetchImpl as unknown as typeof fetch)({
      contactId: "c1", status: "Assigned",
    });
    expect(r).toEqual({ ok: true, action: "unchanged" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the contact has no deal in the configured pipeline", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(listResponse([]));
    const r = await leadstackStageSyncer(env, fetchImpl as unknown as typeof fetch)({
      contactId: "c1", status: "Assigned",
    });
    expect(r).toEqual({ ok: true, action: "no_deal" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a deal in a DIFFERENT pipeline does not count — still no_deal, not touched", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(listResponse([{ id: "d1", pipeline_id: "some-other-pipeline", stage: "assigned" }]));
    const r = await leadstackStageSyncer(env, fetchImpl as unknown as typeof fetch)({
      contactId: "c1", status: "Assigned",
    });
    expect(r).toEqual({ ok: true, action: "no_deal" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("an unknown status is left alone: no deal lookup, no PATCH", async () => {
    const fetchImpl = vi.fn();
    const r = await leadstackStageSyncer(env, fetchImpl as unknown as typeof fetch)({
      contactId: "c1", status: "Some Unmapped Status",
    });
    expect(r).toEqual({ ok: true, action: "unknown_status" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a failed list call as an error without attempting to patch", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("nope", { status: 500 }));
    const r = await leadstackStageSyncer(env, fetchImpl as unknown as typeof fetch)({
      contactId: "c1", status: "Assigned",
    });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("HTTP 500 listing deals") });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports a failed PATCH call as an error", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(listResponse([{ id: "d1", pipeline_id: "install-requests", stage: "new_request" }]))
      .mockResolvedValueOnce(new Response('{"error":"invalid_body"}', { status: 400 }));
    const r = await leadstackStageSyncer(env, fetchImpl as unknown as typeof fetch)({
      contactId: "c1", status: "Assigned",
    });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("HTTP 400 patching deal") });
  });
});
