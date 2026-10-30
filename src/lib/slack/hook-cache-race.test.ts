import { beforeEach, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

/**
 * Breaker repro (#449, brk449b): a hook load in flight across an
 * invalidation must neither refill the cache nor post. Only the service and
 * the transport are faked, so the timing can be held open.
 */

const loadSlackHook = vi.hoisted(() => vi.fn());
const postSlackMessage = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server/slack-service", () => ({
  appUrl: () => null,
  loadSlackHook,
  recordSlackResult: async () => {},
}));
vi.mock("@/lib/slack/client", () => ({ postSlackMessage }));

const { dispatchSlackForWebhookEvent, invalidateSlackHookCache } = await import("@/lib/slack/events");

const input = (sa: string) => ({
  subAccountId: sa, agencyId: "ag1", mode: "live" as const, type: "contact.created" as const,
  payload: { contact: { id: "c1", name: "Ann" } },
});
const HOOK = { webhookUrl: "https://hooks.slack.com/services/T1/B1/aaaa", events: ["contact.created"], includeMessagePreview: false };

beforeEach(() => {
  loadSlackHook.mockReset();
  postSlackMessage.mockReset().mockResolvedValue({ ok: true, error: null, revoked: false });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

it("REPRO 8 an in-flight hook load resurrects a hook after invalidate (disconnect)", async () => {
  let release!: (v: unknown) => void;
  loadSlackHook.mockImplementationOnce(() => new Promise((r) => { release = r; }));
  loadSlackHook.mockResolvedValue(null); // after disconnect the store says: no hook

  const first = dispatchSlackForWebhookEvent(input("sa-race")); // load #1 in flight
  await vi.waitFor(() => expect(loadSlackHook).toHaveBeenCalledTimes(1));
  invalidateSlackHookCache("sa-race"); // DELETE route: disconnect + invalidate
  release(HOOK); // load #1 had read the doc BEFORE the delete
  await first;
  // The event whose load straddled the disconnect is skipped too.
  expect(postSlackMessage, "posted from a load that straddled the disconnect").not.toHaveBeenCalled();

  await dispatchSlackForWebhookEvent(input("sa-race")); // next event, after disconnect completed
  await flushAfterResponse();
  expect(loadSlackHook, "must re-read after invalidate").toHaveBeenCalledTimes(2);
  expect(postSlackMessage, "posted to a disconnected hook").not.toHaveBeenCalled();
});
