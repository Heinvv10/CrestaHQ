import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { mintApiKey } from "@/lib/api/keys";
import { flushAfterResponse } from "@/lib/server/after-response";

/**
 * A write made with a public-API key posts fixed copy to Slack, never the
 * text the key chose. Through the REAL v1 routes (withApiAuth), the real
 * services, the real `emitWebhookEvent` and the real Slack consumer over an
 * in-memory Firestore; only the transport and the delivery queue are faked.
 * A person's write through the same service is the control: its text DOES
 * reach the post, so the test can see a leak.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
const publicFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/webhooks/public-fetch", () => ({ publicFetch }));
vi.mock("@/lib/automations/qstash", () => ({ publishCallback: async () => ({ messageId: "m" }) }));
vi.mock("@/lib/firestore/webhook-subscriptions", () => ({ findMatchingSubscriptions: async () => [] }));
vi.mock("@/lib/push/events", () => ({ dispatchPushForWebhookEvent: async () => {} }));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: async () => ({ enrolled: [], skipped: [], reason: null }),
}));

const tasksRoute = await import("@/app/api/v1/tasks/route");
const taskRoute = await import("@/app/api/v1/tasks/[id]/route");
const dealsRoute = await import("@/app/api/v1/deals/route");
const dealRoute = await import("@/app/api/v1/deals/[id]/route");
const { createTaskServerSide } = await import("@/lib/server/tasks-service");

const HOOK = "https://hooks.slack.com/services/T0001/B0001/aaaaaaaaaaaaaaaaaaaaaaaa";
const CHOSEN = "Call 0800 123 now";

let key = "";
function setup(sa: string) {
  mem.seed(`subAccounts/${sa}`, {
    name: "SA", agencyId: "ag1", apiAccessEnabledByAgency: true,
    slackMeta: {
      connected: true, needsReconnect: false, lastError: null, urlTail: "aaaa",
      events: ["task.created", "task.completed", "deal.created", "deal.stage.changed", "deal.won"],
    },
  });
  mem.seed(`subAccounts/${sa}/private/slack`, { webhookUrl: HOOK, connectedByUid: "u1" });
  const k = mintApiKey("live");
  mem.seed(`subAccounts/${sa}/apiKeys/key-${sa}`, {
    subAccountId: sa, agencyId: "ag1", name: "k", mode: "live", prefix: k.prefix,
    hashedSecret: k.hashedSecret, scopes: ["admin"], revokedAt: null,
  });
  key = k.rawKey;
}

const req = (method: string, path: string, body: unknown) =>
  new Request(`https://app.test${path}`, {
    method, headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(body),
  });

/** Slack post texts, in order. */
async function posts(): Promise<string[]> {
  await flushAfterResponse();
  return publicFetch.mock.calls.map(([, init]) => JSON.parse(init.body).text as string);
}

beforeEach(() => {
  mem.clear();
  publicFetch.mockReset().mockResolvedValue(new Response("ok", { status: 200 }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("API-key writes post fixed copy", () => {
  it("task.created and task.completed over v1", async () => {
    setup("sa-task");
    const created = await tasksRoute.POST(req("POST", "/api/v1/tasks", { title: CHOSEN }), { params: undefined });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { task: { id: string } }).task.id;
    const done = await taskRoute.PATCH(req("PATCH", `/api/v1/tasks/${id}`, { completed: true }), {
      params: Promise.resolve({ id }),
    });
    expect(done.status).toBe(200);
    expect(await posts()).toEqual([
      "Tasks &amp; Events changed by an API agent",
      "Tasks &amp; Events changed by an API agent",
    ]);
  });

  it("deal.created, deal.stage.changed and deal.won over v1", async () => {
    setup("sa-deal");
    mem.seed("contacts/c1", { subAccountId: "sa-deal", agencyId: "ag1", mode: "live", name: CHOSEN });
    const created = await dealsRoute.POST(
      req("POST", "/api/v1/deals", { title: CHOSEN, value: 1, currency: "USD", contact_id: "c1", stage: "new" }),
      { params: undefined },
    );
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { deal: { id: string } }).deal.id;
    const moved = await dealRoute.PATCH(req("PATCH", `/api/v1/deals/${id}`, { stage: "won" }), {
      params: Promise.resolve({ id }),
    });
    expect(moved.status).toBe(200);
    const out = await posts();
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(new Set(out)).toEqual(new Set(["Deals changed by an API agent"]));
  });

  it("an apikey: actor through the service is fixed copy; a person's write is the control", async () => {
    setup("sa-svc");
    const base = {
      agencyId: "ag1", subAccountId: "sa-svc", mode: "live" as const, title: CHOSEN,
      notes: "", dueAt: null, contactId: null, dealId: null, eventId: null,
    };
    await createTaskServerSide({ ...base, createdByUid: "apikey:lsk_live_x" });
    await createTaskServerSide({ ...base, createdByUid: "member-uid" });
    expect(await posts()).toEqual([
      "Tasks &amp; Events changed by an API agent",
      `New task: ${CHOSEN}`,
    ]);
  });
});
