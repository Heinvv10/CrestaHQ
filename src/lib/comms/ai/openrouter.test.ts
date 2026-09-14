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
