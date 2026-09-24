import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callAi } from "./openrouter";

/**
 * callAi's optional caller `signal` (SP5 b round 5): purely additive — it
 * stays armed through the body read, so the caller's own deadline really
 * aborts a stalled body; without it every other caller behaves exactly as
 * before. `fetch` is stubbed.
 */

const ORIGINAL = { ...process.env };
const fetchMock = vi.fn();

function okResponse(content = "hello") {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], model: "m" }) };
}
/** Headers arrived; the body never does — until the fetch signal aborts it. */
function stalledBody(signal: AbortSignal) {
  return {
    ok: true,
    status: 200,
    json: () =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }))),
      ),
  };
}

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "sk-test";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.unstubAllGlobals();
});

describe("without a caller signal (every existing caller)", () => {
  it("returns the text, exactly as before", async () => {
    fetchMock.mockResolvedValueOnce(okResponse("hi there"));
    await expect(callAi({ messages: [{ role: "user", content: "x" }] })).resolves.toMatchObject({ text: "hi there" });
  });

  it("still converts a header stall into the same timeout error", async () => {
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) =>
          init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))),
        ),
    );
    await expect(callAi({ messages: [{ role: "user", content: "x" }], timeoutMs: 5 })).rejects.toThrow(
      "OpenRouter request timed out after 5ms",
    );
  });
});

describe("with a caller signal", () => {
  it("aborts a stalled BODY read when the caller aborts", async () => {
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => stalledBody(init.signal!));
    const controller = new AbortController();
    const pending = callAi({ messages: [{ role: "user", content: "x" }], signal: controller.signal });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps the header timeout: a live caller signal plus timeoutMs 5 still times out after 5 ms", async () => {
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) =>
          init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))),
        ),
    );
    const live = new AbortController(); // never aborted
    await expect(callAi({ messages: [{ role: "user", content: "x" }], timeoutMs: 5, signal: live.signal })).rejects.toThrow(
      "OpenRouter request timed out after 5ms",
    );
  });

  it("an already-aborted signal refuses before any request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(callAi({ messages: [{ role: "user", content: "x" }], signal: controller.signal })).rejects.toThrow(
      "OpenRouter request aborted by the caller",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fallbackToDefault: OpenRouter refuses the chosen model", () => {
  const refused = (status: number, text = '{"error":{"message":"gone/model is not a valid model ID"}}') =>
    ({ ok: false, status, text: async () => text, statusText: "x" });
  const body = (i: number) => JSON.parse(String((fetchMock.mock.calls[i]![1] as RequestInit).body)) as { model: string };

  it("retries ONCE on the app default after a 404/400 and reports the refused model", async () => {
    process.env.AI_REPLIES_DEFAULT_MODEL = "d/default";
    for (const status of [404, 400]) {
      fetchMock.mockReset();
      const onModelRejected = vi.fn();
      fetchMock.mockResolvedValueOnce(refused(status)).mockResolvedValueOnce(okResponse("fine"));
      await expect(
        callAi({ model: "gone/model", fallbackToDefault: true, onModelRejected, messages: [{ role: "user", content: "x" }] }),
      ).resolves.toMatchObject({ text: "fine" });
      expect(body(1).model).toBe("d/default");
      expect(onModelRejected).toHaveBeenCalledWith("gone/model");
    }
  });

  it("a 400 that isn't about the model (context overflow, bad parameter) is not a refusal", async () => {
    for (const text of [
      '{"error":{"message":"This endpoint\'s maximum context length is 200000 tokens"}}',
      '{"error":{"message":"temperature: must be between 0 and 2"}}',
    ]) {
      fetchMock.mockReset();
      const onModelRejected = vi.fn();
      fetchMock.mockResolvedValue(refused(400, text));
      await expect(
        callAi({ model: "a/one", fallbackToDefault: true, onModelRejected, messages: [] }),
      ).rejects.toThrow("OpenRouter 400");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(onModelRejected).not.toHaveBeenCalled();
    }
  });

  it("recognises OpenRouter's no-endpoints 400 as a refusal", async () => {
    fetchMock.mockResolvedValueOnce(refused(400, '{"error":{"message":"No endpoints found for x/y:online."}}'))
      .mockResolvedValueOnce(okResponse("fine"));
    await expect(callAi({ model: "x/y:online", fallbackToDefault: true, messages: [] })).resolves.toMatchObject({ text: "fine" });
  });

  it("does not retry twice, nor on auth/credit/rate errors, nor without the flag, nor when already on the default", async () => {
    fetchMock.mockResolvedValue(refused(404));
    await expect(callAi({ model: "gone/model", fallbackToDefault: true, messages: [] })).rejects.toThrow("OpenRouter 404");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const status of [401, 402, 429]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(refused(status));
      await expect(callAi({ model: "a/one", fallbackToDefault: true, messages: [] })).rejects.toThrow(`OpenRouter ${status}`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(refused(404));
    await expect(callAi({ model: "a/one", messages: [] })).rejects.toThrow("OpenRouter 404");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(refused(404));
    await expect(callAi({ fallbackToDefault: true, messages: [] })).rejects.toThrow("OpenRouter 404");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
