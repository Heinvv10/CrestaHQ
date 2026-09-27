import { describe, expect, it } from "vitest";
import { readBodyCapped } from "./body-limit";

/**
 * readBodyCapped refuses an over-cap body however it is framed: a truthful
 * Content-Length, none at all (chunked), or one smaller than the body.
 */

const CAP = 1000;

/** A streamed body (no Content-Length unless given) sent in 100-byte chunks. */
function streamed(size: number, headers: Record<string, string> = {}) {
  let sent = 0;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (sent >= size) return controller.close();
      const n = Math.min(100, size - sent);
      sent += n;
      controller.enqueue(new Uint8Array(n).fill(120));
    },
  });
  const request = new Request("http://x/", { method: "POST", body, headers, duplex: "half" } as RequestInit);
  return { request, pulls: () => pulls };
}

describe("readBodyCapped", () => {
  it("an at-cap body is read whole", async () => {
    expect(await readBodyCapped(new Request("http://x/", { method: "POST", body: "x".repeat(CAP) }), CAP)).toBe("x".repeat(CAP));
    expect(await readBodyCapped(streamed(CAP).request, CAP)).toBe("x".repeat(CAP));
  });

  it("a truthful Content-Length over the cap is refused before reading", async () => {
    const s = streamed(CAP + 1, { "content-length": String(CAP + 1) });
    expect(s.request.headers.get("content-length")).toBe(String(CAP + 1));
    expect(await readBodyCapped(s.request, CAP)).toBeNull();
    expect(s.pulls()).toBeLessThanOrEqual(1); // the stream's own start-up pull at most
  });

  it("a chunked body with no Content-Length is counted and refused one byte over", async () => {
    const s = streamed(CAP + 1);
    expect(s.request.headers.get("content-length")).toBeNull();
    expect(await readBodyCapped(s.request, CAP)).toBeNull();
  });

  it("a Content-Length smaller than the body doesn't let it through", async () => {
    const s = streamed(5 * CAP, { "content-length": "10" });
    expect(s.request.headers.get("content-length")).toBe("10");
    expect(await readBodyCapped(s.request, CAP)).toBeNull();
    expect(s.pulls()).toBeLessThan(20); // stopped at the cap, not read to the end
  });

  it("no body is empty text", async () => {
    expect(await readBodyCapped(new Request("http://x/", { method: "POST" }), CAP)).toBe("");
  });
});
