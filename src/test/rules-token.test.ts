import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rules tests' shared OAuth token: one mint per process however many
 * evaluate() calls ask, network errors retried with backoff, anything else
 * thrown at once. firebase-admin's `cert` is mocked; nothing leaves the box.
 */

const getAccessToken = vi.fn<() => Promise<{ access_token: string }>>();
vi.mock("firebase-admin/app", () => ({ cert: () => ({ getAccessToken }) }));

const CREDS = { projectId: "p", clientEmail: "e", privateKey: "k" };
const netErr = (code: string) => Object.assign(new Error(`connect ${code}`), { code });
/** gaxios wraps the socket error: the code may sit on a `cause`. */
const wrapped = (code: string) => Object.assign(new Error("request failed"), { cause: netErr(code) });

let rulesAccessToken: typeof import("./rules-token").rulesAccessToken;
beforeEach(async () => {
  vi.resetModules();
  getAccessToken.mockReset();
  ({ rulesAccessToken } = await import("./rules-token"));
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

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
  it("mints once for many concurrent and later callers", async () => {
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

  it("throws anything that is not a network error at once (a bad key is not retried)", async () => {
    getAccessToken.mockRejectedValue(Object.assign(new Error("invalid_grant"), { response: { status: 400 } }));
    await expect(settle(rulesAccessToken(CREDS))).rejects.toThrow("invalid_grant");
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });
});
