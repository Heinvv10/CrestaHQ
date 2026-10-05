import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rules tests' network calls (token and Rules API): network errors and
 * hung attempts retried with backoff, anything else (every HTTP response
 * included) handed back or thrown at once, and token calls within one
 * module instance (one test file) deduped. firebase-admin's `cert` and
 * `fetch` are mocked; nothing leaves the box.
 */

const getAccessToken = vi.fn<() => Promise<{ access_token: string }>>();
vi.mock("firebase-admin/app", () => ({ cert: () => ({ getAccessToken }) }));

const CREDS = { projectId: "p", clientEmail: "e", privateKey: "k" };
const netErr = (code: string) => Object.assign(new Error(`connect ${code}`), { code });
/** gaxios wraps the socket error: the code may sit on a `cause`. */
const wrapped = (code: string) => Object.assign(new Error("request failed"), { cause: netErr(code) });

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
/** undici's shape for a failed connect: TypeError("fetch failed") with the code on `cause`. */
const fetchFailed = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: netErr(code) });

let rulesAccessToken: typeof import("./rules-api").rulesAccessToken;
let rulesFetch: typeof import("./rules-api").rulesFetch;
beforeEach(async () => {
  vi.resetModules();
  getAccessToken.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  ({ rulesAccessToken, rulesFetch } = await import("./rules-api"));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Resolve `p` while letting the backoff timers run. */
async function settle<T>(p: Promise<T>): Promise<T> {
  const done = p.then(
    (v) => ({ v }),
    (e: unknown) => ({ e }),
  );
  await vi.runAllTimersAsync();
  const r = await done;
  if ("e" in r) throw r.e;
  return r.v;
}

describe("rulesAccessToken", () => {
  it("within one module instance (one test file), mints once for concurrent and later callers", async () => {
    getAccessToken.mockResolvedValue({ access_token: "t1" });
    const all = await settle(Promise.all(Array.from({ length: 20 }, () => rulesAccessToken(CREDS))));
    expect(new Set(all)).toEqual(new Set(["t1"]));
    expect(await settle(rulesAccessToken(CREDS))).toBe("t1");
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });

  it("retries network errors (on the error or its cause) and returns the token", async () => {
    getAccessToken
      .mockRejectedValueOnce(netErr("ETIMEDOUT"))
      .mockRejectedValueOnce(wrapped("ECONNRESET"))
      .mockResolvedValueOnce({ access_token: "t2" });
    expect(await settle(rulesAccessToken(CREDS))).toBe("t2");
    expect(getAccessToken).toHaveBeenCalledTimes(3);
  });

  it("gives up after 4 network failures, then a later call mints afresh", async () => {
    getAccessToken.mockRejectedValue(netErr("ETIMEDOUT"));
    await expect(settle(rulesAccessToken(CREDS))).rejects.toThrow("ETIMEDOUT");
    expect(getAccessToken).toHaveBeenCalledTimes(4);
    getAccessToken.mockReset().mockResolvedValue({ access_token: "t3" });
    expect(await settle(rulesAccessToken(CREDS))).toBe("t3");
  });

  it("an attempt that never answers is given up on after 15 s and retried", async () => {
    getAccessToken.mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce({ access_token: "t4" });
    expect(await settle(rulesAccessToken(CREDS))).toBe("t4");
    expect(getAccessToken).toHaveBeenCalledTimes(2);
  });

  it("the worst-case budget (token + Rules API call) fits the rules config's hookTimeout", async () => {
    const { MAX_EVALUATE_MS } = await import("./rules-api");
    const config = (await import("../../vitest.rules.config.mts")).default as { test?: { hookTimeout?: number } };
    // 2 calls × (4 attempts × 15 s + 1 + 2 + 4 s backoff).
    expect(MAX_EVALUATE_MS).toBe(134_000);
    expect(config.test?.hookTimeout).toBeGreaterThan(MAX_EVALUATE_MS);
  });

  it("throws anything that is not a network error at once (a bad key is not retried)", async () => {
    getAccessToken.mockRejectedValue(Object.assign(new Error("invalid_grant"), { response: { status: 400 } }));
    await expect(settle(rulesAccessToken(CREDS))).rejects.toThrow("invalid_grant");
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });
});

describe("rulesFetch", () => {
  const URL_ = "https://firebaserules.googleapis.com/v1/projects/p:test";
  const INIT = { method: "POST", body: "{}" };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it("retries undici connect timeouts and socket errors, then hands back the response", async () => {
    fetchMock
      .mockRejectedValueOnce(fetchFailed("UND_ERR_CONNECT_TIMEOUT"))
      .mockRejectedValueOnce(fetchFailed("UND_ERR_SOCKET"))
      .mockResolvedValueOnce(json(200, { testResults: [] }));
    const res = await settle(rulesFetch(URL_, INIT));
    expect([res.status, await res.json()]).toEqual([200, { testResults: [] }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]![1]).toMatchObject(INIT);
  });

  it.each([400, 403, 500, 503])("never retries an HTTP %i: handed back as is, one call", async (status) => {
    fetchMock.mockResolvedValue(json(status, { error: { message: "nope" } }));
    const res = await settle(rulesFetch(URL_, INIT));
    expect([res.status, res.ok, await res.json()]).toEqual([status, false, { error: { message: "nope" } }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a request that never answers is aborted after 15 s and retried", async () => {
    let first: AbortSignal | undefined;
    fetchMock
      .mockImplementationOnce((_url, init) => ((first = init.signal ?? undefined), new Promise(() => {})))
      .mockResolvedValueOnce(json(200, { ok: 1 }));
    expect((await settle(rulesFetch(URL_, INIT))).status).toBe(200);
    expect(first?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after 4 connect timeouts, throwing the last one", async () => {
    fetchMock.mockRejectedValue(fetchFailed("UND_ERR_CONNECT_TIMEOUT"));
    await expect(settle(rulesFetch(URL_, INIT))).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("throws a non-network failure at once", async () => {
    fetchMock.mockRejectedValue(new TypeError("Invalid URL"));
    await expect(settle(rulesFetch(URL_, INIT))).rejects.toThrow("Invalid URL");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
