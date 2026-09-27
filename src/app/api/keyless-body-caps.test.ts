import { beforeAll, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Every keyless route that read its body uncapped now refuses one over its
 * cap with a 413, however the size is framed: a truthful Content-Length,
 * none (chunked), or one smaller than the body. A body at the cap is read
 * (whatever the route then answers, it isn't a 413).
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const KB = 1024;
const SECRET = "test-secret-keyless-caps-fixture";

type Route = (r: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>;
const ROUTES: Array<[string, number, () => Promise<{ handler: Route; path: string; params: Record<string, string> }>]> = [];
const add = (name: string, cap: number, load: () => Promise<{ handler: unknown; path: string; params?: Record<string, string> }>) =>
  ROUTES.push([name, cap, async () => {
    const r = await load();
    return { handler: r.handler as Route, path: r.path, params: r.params ?? {} };
  }]);

add("forms/[id]/submit", 64 * KB, async () => ({ handler: (await import("./forms/[id]/submit/route")).POST, path: "/f", params: { id: "f1" } }));
add("co/[subAccountId]/[slug]/session", 16 * KB, async () => ({ handler: (await import("./co/[subAccountId]/[slug]/session/route")).POST, path: "/co", params: { subAccountId: "sa1", slug: "s" } }));
add("web-chat/capture", 16 * KB, async () => ({ handler: (await import("./web-chat/capture/route")).POST, path: "/wc" }));
add("web-chat/message", 16 * KB, async () => ({ handler: (await import("./web-chat/message/route")).POST, path: "/wc" }));
add("reviews/feedback", 16 * KB, async () => ({ handler: (await import("./reviews/feedback/route")).POST, path: "/rf" }));
add("quotes/[token]/respond", 16 * KB, async () => {
  const { issueQuoteToken } = await import("@/lib/quotes/token");
  return { handler: (await import("./quotes/[token]/respond/route")).POST, path: "/q", params: { token: issueQuoteToken("q1").token } };
});
add("events/[token]/reschedule", 16 * KB, async () => {
  const { issueEventToken } = await import("@/lib/booking/event-token");
  return { handler: (await import("./events/[token]/reschedule/route")).POST, path: "/e", params: { token: issueEventToken("e1").token } };
});
add("webhooks/stripe", 1024 * KB, async () => ({ handler: (await import("./webhooks/stripe/route")).POST, path: "/ws" }));
add("webhooks/stripe/sa", 1024 * KB, async () => ({ handler: (await import("./webhooks/stripe/sa/[subAccountId]/route")).POST, path: "/ws", params: { subAccountId: "sa1" } }));
add("webhooks/paystack", 1024 * KB, async () => ({ handler: (await import("./webhooks/paystack/route")).POST, path: "/wp" }));
add("webhooks/paystack/sa", 1024 * KB, async () => ({ handler: (await import("./webhooks/paystack/sa/[subAccountId]/route")).POST, path: "/wp", params: { subAccountId: "sa1" } }));
add("webhooks/webinar1/sa", 1024 * KB, async () => ({ handler: (await import("./webhooks/webinar1/sa/[subAccountId]/route")).POST, path: "/ww", params: { subAccountId: "sa1" } }));
add("webhooks/vapi/status", 1024 * KB, async () => ({ handler: (await import("./webhooks/vapi/status/[subAccountId]/route")).POST, path: `/wv?s=${SECRET}`, params: { subAccountId: "sa1" } }));
add("webhooks/vapi/llm", 1024 * KB, async () => ({ handler: (await import("./webhooks/vapi/llm/[subAccountId]/route")).POST, path: `/wv?s=${SECRET}`, params: { subAccountId: "sa1" } }));
add("webhooks/vapi/end-of-call", 4096 * KB, async () => ({ handler: (await import("./webhooks/vapi/end-of-call/[subAccountId]/route")).POST, path: `/wv?s=${SECRET}`, params: { subAccountId: "sa1" } }));

beforeAll(() => {
  process.env.AUTOMATIONS_TOKEN_SECRET = SECRET;
  process.env.VAPI_WEBHOOK_SECRET = SECRET;
  process.env.PAYSTACK_SECRET_KEY = "sk_test_keyless";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_keyless";
});

/** A JSON object of exactly `size` bytes. */
const jsonOf = (size: number) => `{"pad":"${"x".repeat(size - 10)}"}`;
let ip = 0;

function request(path: string, text: string, frame: "plain" | "chunked" | "lying") {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": `198.18.${Math.floor(++ip / 250)}.${ip % 250}` };
  if (frame === "plain") return new Request(`http://localhost${path}`, { method: "POST", headers, body: text });
  if (frame === "lying") headers["content-length"] = "8";
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
  return new Request(`http://localhost${path}`, { method: "POST", headers, body, duplex: "half" } as RequestInit);
}

describe.each(ROUTES.filter(([n]) => n.startsWith("webhooks/")))("%s logs its 413", (_name, cap, load) => {
  it("one line: route, sub-account if known, declared length; never the body", async () => {
    const { handler, path, params } = await load();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await handler(request(path, jsonOf(cap + 1), "lying"), { params: Promise.resolve(params) });
    const lines = warn.mock.calls.map((c) => c.map(String).join(" "));
    warn.mockRestore();
    expect(res.status).toBe(413);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\] 413: body over the cap/);
    expect(lines[0]).toContain("content-length=8");
    if (params.subAccountId) expect(lines[0]).toContain(`sa=${params.subAccountId}`);
    expect(lines[0]).not.toContain("xxxx");
  });
});

describe.each(ROUTES)("%s (cap %i bytes)", (_name, cap, load) => {
  it.each(["plain", "chunked", "lying"] as const)("one byte over the cap, %s framing -> 413", async (frame) => {
    const { handler, path, params } = await load();
    expect(jsonOf(cap + 1).length).toBe(cap + 1);
    const res = await handler(request(path, jsonOf(cap + 1), frame), { params: Promise.resolve(params) });
    expect(res.status).toBe(413);
  });

  it("a body at the cap is read (not a 413)", async () => {
    const { handler, path, params } = await load();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handler(request(path, jsonOf(cap), "chunked"), { params: Promise.resolve(params) });
    warn.mockRestore();
    err.mockRestore();
    expect(res.status).not.toBe(413);
  });
});
