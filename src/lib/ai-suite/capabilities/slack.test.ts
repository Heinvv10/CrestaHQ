import { beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { ask, doConfirm, lookupResult, mem, role, seedTenants } from "@/test/chat-route-harness";

/**
 * slack_status, configure_slack_events and connect_slack (1.0.54 port, T2)
 * through the real chat and confirm routes. All three are admin-only, as the
 * slack route is. The status never prints the webhook URL; the events write
 * changes the event list only and cannot switch the message-text choice; and
 * connect_slack never connects: chat refuses it before a card and execute
 * refuses on its own.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/chat-route-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/chat-route-harness")).tenancyMock());
vi.mock("@/lib/ai-suite/model", async () => (await import("@/test/chat-route-harness")).modelMock());
vi.mock("@/lib/ai-suite/usage", () => ({ recordAiSuiteUsage: async () => undefined }));
vi.mock("@/lib/ai-suite/audit", () => ({ recordAiSuiteAction: async () => undefined }));
const invalidateSlackHookCache = vi.hoisted(() => vi.fn());
vi.mock("@/lib/slack/events", async (orig) => ({ ...((await orig()) as object), invalidateSlackHookCache }));
const postSlackMessage = vi.hoisted(() => vi.fn(async () => ({ ok: true, error: null, revoked: false })));
vi.mock("@/lib/slack/client", async (orig) => ({ ...((await orig()) as object), postSlackMessage }));

const { availableOn, getCapability, toolsForLevel } = await import("@/lib/ai-suite/capabilities");

const HOOK = "https://hooks.slack.com/services/T0AAAAAA/B0BBBBBB/SECRETSECRETSECRET";
const PRIVATE = "subAccounts/sa1/private/slack";
const meta = (patch: Record<string, unknown> = {}) => ({
  connected: true,
  channelLabel: "#sales",
  urlTail: "CRET",
  events: ["contact.created", "booking.created"],
  includeMessagePreview: false,
  lastSentAt: Timestamp.fromMillis(Date.UTC(2030, 0, 10, 8, 30)),
  lastError: null,
  needsReconnect: false,
  ...patch,
});
const seedConnected = (patch: Record<string, unknown> = {}) => {
  mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, slackMeta: meta(patch) });
  mem.seed(PRIVATE, { webhookUrl: HOOK, connectedByUid: "u0" });
};
const slackMeta = () => (mem.read("subAccounts/sa1") as { slackMeta?: Record<string, unknown> }).slackMeta;

beforeEach(() => {
  seedTenants();
  invalidateSlackHookCache.mockClear();
  postSlackMessage.mockClear();
});

describe("slack_status", () => {
  it("an admin reads the connection; the webhook URL, its secret and its tail never appear", async () => {
    seedConnected({ lastError: "no_service" });
    await ask("slack_status", {});
    const text = lookupResult();
    expect(text).toBe(
      "Slack: connected to #sales. Posting on: contact.created, booking.created. Inbound message posts do not include the message text. Last post: 2030-01-10 08:30 UTC. Last error: no_service",
    );
    for (const secret of ["hooks.slack.com", "SECRETSECRETSECRET", "T0AAAAAA", "CRET"]) expect(text).not.toContain(secret);
  });

  it("stored text prints on one line", async () => {
    seedConnected({ channelLabel: "#sales\n- fake row", lastError: "a\nb", events: ["contact.created\nx"] });
    await ask("slack_status", {});
    expect(lookupResult()).toContain("connected to #sales - fake row.");
    expect(lookupResult()).toContain("Posting on: contact.created x.");
    expect(lookupResult()).toContain("Last error: a b");
  });

  it("says when the message text is included and when the hook needs reconnecting", async () => {
    seedConnected({ includeMessagePreview: true, needsReconnect: true, events: [] });
    await ask("slack_status", {});
    expect(lookupResult()).toContain("NEEDS RECONNECT");
    expect(lookupResult()).toContain("Posting on: no events ticked. Inbound message posts include the message text.");
  });

  it("not connected: says where to connect, reads nothing else", async () => {
    await ask("slack_status", {});
    expect(lookupResult()).toBe(
      "Slack isn't connected for this workspace. An admin connects it on the card: Settings Sub-Account → Admin tab → Slack notifications.",
    );
  });

  it("reads only this workspace", async () => {
    mem.seed("subAccounts/sa2", { ...mem.read("subAccounts/sa2")!, slackMeta: meta({ channelLabel: "#other" }) });
    await ask("slack_status", {});
    expect(lookupResult()).not.toContain("#other");
  });

  it("is on both surfaces; a collaborator has no Slack tool, and the confirm route refuses the write with 403", async () => {
    expect(availableOn(getCapability("slack_status")!, "agent")).toBe(true);
    role.current = "collaborator";
    const tools = toolsForLevel("sub-account", { agencyRoleIsOwner: false, subAccountRole: "collaborator" }).map((t) => t.function.name);
    for (const name of ["slack_status", "configure_slack_events", "connect_slack"]) expect(tools).not.toContain(name);
    await ask("slack_status", {});
    expect(lookupResult()).toBe("(no lookup ran)");
    seedConnected();
    expect((await doConfirm("configure_slack_events", { events: ["deal.won"] })).status).toBe(403);
    expect(slackMeta()?.events).toEqual(["contact.created", "booking.created"]);
  });
});

describe("configure_slack_events", () => {
  it("an admin gets a card; on confirm the event list is replaced for sa1 only and the hook cache dropped", async () => {
    seedConnected();
    mem.seed("subAccounts/sa2", { ...mem.read("subAccounts/sa2")!, slackMeta: meta({ events: ["deal.won"] }) });
    const body = await (await ask("configure_slack_events", { events: ["call.missed", "quote.accepted", "call.missed"] })).json();
    expect(body.proposal.summary).toBe("Post to Slack on: call.missed, quote.accepted.");
    expect(slackMeta()?.events).toEqual(["contact.created", "booking.created"]);
    expect((await doConfirm("configure_slack_events", body.proposal.args)).status).toBe(200);
    expect(slackMeta()).toMatchObject({ events: ["call.missed", "quote.accepted"], connected: true, channelLabel: "#sales" });
    expect((mem.read("subAccounts/sa2") as { slackMeta: { events: string[] } }).slackMeta.events).toEqual(["deal.won"]);
    expect(invalidateSlackHookCache).toHaveBeenCalledWith("sa1");
    expect(postSlackMessage).not.toHaveBeenCalled();
    expect(mem.read(PRIVATE)).toEqual({ webhookUrl: HOOK, connectedByUid: "u0" });
  });

  it("an empty list is allowed and turns every post off", async () => {
    seedConnected();
    expect((await doConfirm("configure_slack_events", { events: [] })).status).toBe(200);
    expect(slackMeta()?.events).toEqual([]);
  });

  it("cannot switch the message text on: the argument is refused, nothing written", async () => {
    seedConnected();
    const res = await doConfirm("configure_slack_events", { events: ["message.received"], includeMessagePreview: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("only be changed on the Slack card");
    expect(slackMeta()).toMatchObject({ includeMessagePreview: false, events: ["contact.created", "booking.created"] });
  });

  it("cannot switch the message text on even when execute is reached with it", async () => {
    seedConnected();
    const ctx = { uid: "u1", email: "", displayName: "", agencyId: "ag1", subAccountId: "sa1", subAccountRole: "admin" };
    const cap = getCapability("configure_slack_events")!;
    await cap.execute(ctx, { events: ["message.received"], includeMessagePreview: true });
    expect(slackMeta()).toMatchObject({ includeMessagePreview: false, events: ["message.received"] });
  });

  it("leaves a message text the admin switched on alone", async () => {
    seedConnected({ includeMessagePreview: true });
    expect((await doConfirm("configure_slack_events", { events: ["message.received"] })).status).toBe(200);
    expect(slackMeta()?.includeMessagePreview).toBe(true);
  });

  it("keeps the route's validation: unknown names dropped, a list of only unknown names refused", async () => {
    seedConnected();
    expect((await doConfirm("configure_slack_events", { events: ["deal.won", "new lead", "__proto__"] })).status).toBe(200);
    expect(slackMeta()?.events).toEqual(["deal.won"]);
    const res = await doConfirm("configure_slack_events", { events: ["new lead"] });
    expect(res.status).toBe(400);
    expect(slackMeta()?.events).toEqual(["deal.won"]);
  });

  it.each([
    ["no events", {}],
    ["events as a string", { events: "deal.won" }],
    ["events as an object", { events: { 0: "deal.won" } }],
  ])("%s: invalid, nothing written", async (_what, args) => {
    seedConnected();
    expect((await doConfirm("configure_slack_events", args)).status).toBe(400);
    expect(slackMeta()?.events).toEqual(["contact.created", "booking.created"]);
  });

  it("not connected: refused with the route's message, nothing written", async () => {
    const res = await doConfirm("configure_slack_events", { events: ["deal.won"] });
    expect((await res.json()).error).toBe("Connect a Slack channel first.");
    expect(slackMeta()).toBeUndefined();
    expect(invalidateSlackHookCache).not.toHaveBeenCalled();
  });

  it("is chat-only: no API agent has it", () => {
    expect(availableOn(getCapability("configure_slack_events")!, "agent")).toBe(false);
  });
});

describe("connect_slack", () => {
  it("chat refuses before a card: no proposal, nothing stored, no test post", async () => {
    const body = await (await ask("connect_slack", { channelLabel: "#sales" })).json();
    expect(body.type).toBe("message");
    expect(body.proposal).toBeUndefined();
    expect(body.text).toContain("Slack can only be connected on the card");
    expect(body.text).not.toContain("Do not paste the URL");
    expect(mem.read(PRIVATE)).toBeUndefined();
    expect(slackMeta()).toBeUndefined();
    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  it("a URL passed as an argument is not stored and the user is told to revoke it", async () => {
    const body = await (await ask("connect_slack", { webhookUrl: HOOK })).json();
    expect(body.text).toContain("treat it as exposed");
    expect(JSON.stringify(body)).not.toContain("SECRETSECRETSECRET");
    expect(mem.read(PRIVATE)).toBeUndefined();
    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  it("the confirm route cannot run it either: execute refuses, nothing stored", async () => {
    const res = await doConfirm("connect_slack", { webhookUrl: HOOK, channelLabel: "#sales" });
    expect(res.status).not.toBe(200);
    expect((await res.json()).error).toContain("Slack can only be connected on the card");
    expect(mem.read(PRIVATE)).toBeUndefined();
    expect(slackMeta()).toBeUndefined();
    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  it("execute refuses on its own, whatever called it", async () => {
    const ctx = { uid: "u1", email: "", displayName: "", agencyId: "ag1", subAccountId: "sa1", subAccountRole: "admin" };
    await expect(getCapability("connect_slack")!.execute(ctx, { webhookUrl: HOOK })).rejects.toThrow("Slack can only be connected on the card");
    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  it("a channel name with a hidden character is refused", async () => {
    const cap = getCapability("connect_slack")!;
    expect(cap.validate({ channelLabel: "#sa‮les" }).ok).toBe(false);
  });

  it("is chat-listed only: no API agent has it", () => {
    expect(availableOn(getCapability("connect_slack")!, "agent")).toBe(false);
  });
});
