import { describe, expect, it, vi } from "vitest";
import { leadstackFetch } from "./leadstack-fetch.ts";
import { leadstackUpserter, type Env } from "./run.ts";
import { leadstackDealEnsurer } from "./deals.ts";

const rateLimited = (init: ResponseInit = {}) =>
  new Response(
    '{"error":{"type":"rate_limit_error","code":"rate_limited","message":"Too many requests. Retry after 3s."}}',
    { status: 429, ...init },
  );

function harness(...responses: (Response | Error)[]) {
  const fetchImpl = vi.fn();
  for (const r of responses) {
    if (r instanceof Error) fetchImpl.mockRejectedValueOnce(r);
    else fetchImpl.mockResolvedValueOnce(r);
  }
  const sleep = vi.fn(async () => {});
  return { fetchImpl, sleep, lsFetch: leadstackFetch(fetchImpl as unknown as typeof fetch, { sleep }) };
}

describe("leadstackFetch", () => {
  it("retries a 429 after the Retry-After header's delay", async () => {
    const { fetchImpl, sleep, lsFetch } = harness(
      rateLimited({ headers: { "Retry-After": "1" } }),
      new Response("ok", { status: 200 }),
    );
    const res = await lsFetch("https://crm.test/x", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
    // Every attempt carries its own timeout signal and the original init.
    for (const [, init] of fetchImpl.mock.calls as unknown as [string, RequestInit][]) {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.method).toBe("POST");
    }
  });

  it("parses 'Retry after Ns.' from the body when there is no header", async () => {
    const { sleep, lsFetch } = harness(rateLimited(), new Response("ok", { status: 200 }));
    expect((await lsFetch("https://crm.test/x")).status).toBe(200);
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("defaults to 2s with neither header nor parseable body, and caps at 10s", async () => {
    const { sleep, lsFetch } = harness(
      new Response("slow down", { status: 429 }),
      rateLimited({ headers: { "Retry-After": "60" } }),
      new Response("ok", { status: 200 }),
    );
    expect((await lsFetch("https://crm.test/x")).status).toBe(200);
    expect(sleep.mock.calls).toEqual([[2000], [10000]]);
  });

  it("gives up after 3 retries and returns the final 429", async () => {
    const { fetchImpl, lsFetch } = harness(rateLimited(), rateLimited(), rateLimited(), rateLimited(), new Response("ok"));
    const res = await lsFetch("https://crm.test/x");
    expect(res.status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("passes non-429 responses straight through without retrying", async () => {
    for (const status of [200, 404, 500]) {
      const { fetchImpl, sleep, lsFetch } = harness(new Response("x", { status }), new Response("never"));
      expect((await lsFetch("https://crm.test/x")).status).toBe(status);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  it("does not retry on a network error", async () => {
    const { fetchImpl, lsFetch } = harness(new TypeError("fetch failed"), new Response("never"));
    await expect(lsFetch("https://crm.test/x")).rejects.toThrow("fetch failed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("LeadStack call sites retry through the helper", () => {
  const env = {
    LEADSTACK_API_URL: "https://crm.test",
    LEADSTACK_API_KEY: "sk_test",
    QCONTACT_DEAL_PIPELINE_ID: "p",
    QCONTACT_DEAL_STAGE: "s",
    QCONTACT_DEAL_OWNER_UID: undefined,
  };

  it("run.ts upsert succeeds when the first attempt is 429 and the second is 200", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(rateLimited())
        .mockResolvedValueOnce(new Response('{"contact":{"id":"c1"}}', { status: 200 }));
      const upsert = leadstackUpserter(env as unknown as Env, fetchImpl as unknown as typeof fetch);
      const p = upsert({ custom_fields: { qcontact_case_id: "42" } } as unknown as Parameters<typeof upsert>[0]);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await p).toEqual({ ok: true, contactId: "c1" });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deals.ts create succeeds when the first attempt is 429 and the second is 201", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(new Response('{"object":"list","data":[],"has_more":false}', { status: 200 }))
        .mockResolvedValueOnce(rateLimited())
        .mockResolvedValueOnce(new Response('{"deal":{"id":"d1"}}', { status: 201 }));
      const p = leadstackDealEnsurer(env, fetchImpl as unknown as typeof fetch)({ contactId: "c1", caseId: 42, title: "t" });
      await vi.advanceTimersByTimeAsync(3000);
      expect(await p).toEqual({ ok: true, dealId: "d1" });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
