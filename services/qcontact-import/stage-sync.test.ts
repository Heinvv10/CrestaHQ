import { describe, expect, it, vi } from "vitest";
import { leadstackStageSyncer, statusToStageId, type StageSyncEnv } from "./stage-sync.ts";

const env: StageSyncEnv = {
  LEADSTACK_API_URL: "https://crm.test",
  LEADSTACK_API_KEY: "sk_test",
};

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
  it("PATCHes the deal to the given stage with no prior lookup call", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('{"deal":{"id":"d1"}}', { status: 200 }));
    const r = await leadstackStageSyncer(env, fetchImpl as unknown as typeof fetch)({ dealId: "d1", stage: "assigned" });
    expect(r).toEqual({ ok: true, action: "patched" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://crm.test/api/v1/deals/d1");
    expect(init.method).toBe("PATCH");
    expect(init.headers).toMatchObject({ Authorization: "Bearer sk_test", "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ stage: "assigned" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports a 404 as action 'not_found', not an error", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('{"error":"deal_not_found"}', { status: 404 }));
    const r = await leadstackStageSyncer(env, fetchImpl as unknown as typeof fetch)({ dealId: "d1", stage: "assigned" });
    expect(r).toEqual({ ok: true, action: "not_found" });
  });

  it("reports a non-404 failure as an error", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('{"error":"invalid_body"}', { status: 400 }));
    const r = await leadstackStageSyncer(env, fetchImpl as unknown as typeof fetch)({ dealId: "d1", stage: "assigned" });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("HTTP 400 patching deal") });
  });
});
