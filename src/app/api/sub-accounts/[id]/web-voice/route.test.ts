import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/sub-accounts/[id]/web-voice (WV-1). Real tenancy, route, service and
 * ElevenLabs client on the in-memory Firestore; only `fetch` (the network
 * seam) is faked, answering as ElevenLabs and as our own app URL. Every
 * refusal must write nothing, and no response or parent-doc field may carry
 * the key or the endpoint secret.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

const { mem, claims, storeDb } = await import("@/test/gbp-sync-store");
const { GET, POST, PATCH, DELETE } = await import("./route");
const { updateWebVoiceSettings } = await import("@/lib/server/web-voice-service");
const { Timestamp } = await import("firebase-admin/firestore");
const { verifyWidgetToken } = await import("@/lib/web-voice/tokens");

// Built at runtime: a long key literal reads as a credential to the secret scan.
const KEY = `el_test_${"a".repeat(24)}`;
const KEY2 = `el_test_${"b".repeat(24)}`;
const SECRET = "subAccounts/sa1/private/webVoiceConnection";
const USAGE = "subAccounts/sa1/private/webVoiceUsage";
const EL = "https://api.elevenlabs.io";
const APP = "https://app.test";

const ctx = (id = "sa1") => ({ params: Promise.resolve({ id }) });
const req = (method: string, body?: unknown, uid = "admin1", query = "") =>
  new Request(`${APP}/api/sub-accounts/sa1/web-voice${query}`, {
    method,
    headers: { "x-user-uid": uid, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

type AgentBody = {
  name: string;
  conversation_config: { agent: { prompt: { custom_llm: { url: string } } }; tts: { model_id: string } };
  platform_settings: { auth: { enable_auth: boolean } };
};
type Call = { url: string; method: string; key: string | null; body: unknown };
let calls: Call[] = [];
let agents: Map<string, string>; // agentId → key that owns it
let agentSeq = 0;
/** Runs inside the fake ElevenLabs create call — lets a test commit a rival write mid-flight. */
let onCreate: (() => void) | null = null;

const VOICES = [
  { voice_id: "cloned0001", name: "Zed", category: "cloned", labels: {} },
  {
    voice_id: "premade001",
    name: "Aria",
    category: "premade",
    labels: { accent: "american", gender: "female" },
    preview_url: "https://storage.googleapis.com/eleven-public-prod/aria.mp3",
  },
  { voice_id: "premade002", name: "Bob", category: "premade", preview_url: "https://127.0.0.1/x.mp3" },
  { voice_id: "premade003", name: "Cid", category: "premade", preview_url: "http://cdn.example.com/x.mp3" },
  { voice_id: "premade004", name: "Dee", category: "premade", preview_url: "javascript:alert(1)" },
];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url.startsWith(APP)) return new Response("", { status: 200 }); // resolvedAppUrl's own probe
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const key = headers["xi-api-key"] ?? null;
  const method = init?.method ?? "GET";
  calls.push({ url, method, key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
  if (!url.startsWith(`${EL}/`)) throw new Error(`unexpected host ${url}`);
  if (key !== KEY && key !== KEY2) return json(401, { detail: { status: "invalid_api_key", message: "Invalid API key" } });
  const path = url.slice(EL.length);
  if (method === "GET" && path === "/v1/voices") return json(200, { voices: VOICES });
  if (method === "POST" && path === "/v1/convai/agents/create") {
    onCreate?.();
    const id = `agent${++agentSeq}`;
    agents.set(id, key);
    return json(200, { agent_id: id });
  }
  const m = /^\/v1\/convai\/agents\/([^/?]+)$/.exec(path);
  if (m && (method === "PATCH" || method === "DELETE")) {
    if (agents.get(m[1]) !== key) return json(404, { detail: "Agent not found" });
    if (method === "DELETE") agents.delete(m[1]);
    return json(200, {});
  }
  return json(400, { detail: "unhandled in fake" });
}

const fetchMock = vi.fn(fakeFetch);
const warn = vi.fn();
const error = vi.fn();

function noLeak(value: unknown) {
  const s = JSON.stringify(value);
  expect(s).not.toContain(KEY);
  expect(s).not.toContain(KEY2);
  const endpointSecret = mem.read(SECRET)?.endpointSecret;
  if (typeof endpointSecret === "string") expect(s).not.toContain(endpointSecret);
}

async function body(res: Response) {
  const out = (await res.json()) as Record<string, unknown>;
  noLeak(out);
  return out;
}

const elCalls = (method: string, pathPrefix: string) =>
  calls.filter((c) => c.method === method && c.url.startsWith(`${EL}${pathPrefix}`));

beforeEach(() => {
  mem.clear();
  claims.clear();
  calls = [];
  agents = new Map();
  agentSeq = 0;
  onCreate = null;
  fetchMock.mockClear().mockImplementation(fakeFetch);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", APP);
  vi.spyOn(console, "warn").mockImplementation(warn.mockClear());
  vi.spyOn(console, "error").mockImplementation(error.mockClear());
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Acme Plumbing", webVoiceEnabledByAgency: true });
  mem.seed("subAccounts/sa2", { agencyId: "ag1", name: "Two", webVoiceEnabledByAgency: true });
  mem.seed("subAccounts/sa1/subAccountMembers/admin1", { status: "active", role: "admin" });
  mem.seed("subAccounts/sa1/subAccountMembers/member1", { status: "active", role: "member" });
  mem.seed("subAccounts/sa2/subAccountMembers/admin2", { status: "active", role: "admin" });
  for (const uid of ["admin1", "member1", "admin2"]) claims.set(uid, { status: "active", agencyId: "ag1", agencyRole: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const connect = async (apiKey = KEY) => POST(req("POST", { apiKey }), ctx());
const greetingOf = (c: Call) =>
  (c.body as { conversation_config: { agent: { first_message: string } } }).conversation_config.agent.first_message;

describe("tenancy and ids", () => {
  it.each([
    ["a plain member", "member1"],
    ["another sub-account's admin", "admin2"],
  ])("%s gets 403 on every method; nothing is fetched or written", async (_n, uid) => {
    for (const [handler, method, payload] of [
      [GET, "GET", undefined],
      [POST, "POST", { apiKey: KEY }],
      [PATCH, "PATCH", { greeting: "Hi" }],
      [DELETE, "DELETE", undefined],
    ] as const) {
      expect((await handler(req(method, payload, uid), ctx())).status).toBe(403);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mem.read(SECRET)).toBeUndefined();
    expect(mem.read("subAccounts/sa1")).not.toHaveProperty("webVoiceMeta");
  });

  it.each(["..", ".", "__x__", ""])("id %j is refused before any Firestore read", async (id) => {
    const doc = vi.spyOn(storeDb, "doc");
    for (const handler of [GET, POST, PATCH, DELETE]) {
      const res = await handler(req("POST", { apiKey: KEY }), ctx(id));
      expect(res.status).toBe(404);
    }
    expect(doc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("agency gate", () => {
  beforeEach(() => mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Acme Plumbing", webVoiceEnabledByAgency: false }));

  it("POST and PATCH answer 403 gate_off with nothing fetched or written", async () => {
    for (const res of [await connect(), await PATCH(req("PATCH", { greeting: "Hi" }), ctx())]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "gate_off" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mem.read(SECRET)).toBeUndefined();
  });

  it("GET reports the gate off and lists no voices even when asked", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", webVoiceEnabledByAgency: false, webVoiceMeta: { ready: true } });
    mem.seed(SECRET, { apiKey: KEY, endpointSecret: "s".repeat(32), agentId: "agent9" });
    const out = await body(await GET(req("GET", undefined, "admin1", "?voices=1"), ctx()));
    expect(out).toMatchObject({ gateOn: false, voices: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("DELETE stays ungated: a client can always remove their key", async () => {
    mem.seed(SECRET, { apiKey: KEY, endpointSecret: "s".repeat(32), agentId: "agent9", rev: "r1" });
    agents.set("agent9", KEY);
    expect((await DELETE(req("DELETE"), ctx())).status).toBe(200);
    expect(mem.read(SECRET)).toBeUndefined();
    expect(agents.has("agent9")).toBe(false);
  });
});

describe("POST — connect", () => {
  it("probes the key, then stores it only in private/ and provisions a private custom-LLM agent", async () => {
    const res = await connect(` ${KEY} `);
    expect(res.status).toBe(200);
    const out = await body(res);

    // Probe first, then create; every outbound call went to ElevenLabs with the key.
    expect(calls.map((c) => `${c.method} ${c.url.slice(EL.length)}`)).toEqual([
      "GET /v1/voices",
      "POST /v1/convai/agents/create",
    ]);
    expect(calls.every((c) => c.key === KEY)).toBe(true);

    const secret = mem.read(SECRET)!;
    expect(secret).toMatchObject({ apiKey: KEY, agentId: "agent1", voiceId: "premade001", voiceName: "Aria" });
    expect(secret.endpointSecret).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const agent = calls[1].body as AgentBody;
    expect(agent.conversation_config.agent.prompt.custom_llm.url).toBe(
      `${APP}/api/webhooks/elevenlabs/llm/sa1/${secret.endpointSecret}`,
    );
    expect(agent.platform_settings.auth.enable_auth).toBe(true);
    expect(agent.name).toBe("Acme Plumbing — website voice");

    const sub = mem.read("subAccounts/sa1")!;
    noLeak(sub);
    // A clean sync is ready: the reply webhook the agent calls exists (WV-2).
    expect(sub.webVoiceMeta).toMatchObject({
      ready: true,
      keyLast4: "aaaa",
      lastError: null,
      voiceId: "premade001",
    });
    expect(Object.keys(sub.webVoiceMeta as object)).not.toEqual(expect.arrayContaining(["apiKey", "endpointSecret", "agentId"]));
    expect(out.meta).toMatchObject({ ready: true, connectedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
  });

  it("returns voices with only public https preview URLs", async () => {
    const out = await body(await connect());
    const voices = out.voices as Array<{ voiceId: string; previewUrl: string | null; description: string | null }>;
    expect(voices.map((v) => v.voiceId)).toEqual(["premade001", "premade002", "premade003", "premade004", "cloned0001"]);
    expect(voices[0]).toMatchObject({
      previewUrl: "https://storage.googleapis.com/eleven-public-prod/aria.mp3",
      description: "american · female",
    });
    // A private address, plain http and a script URL never reach the card.
    expect(voices.slice(1, 4).map((v) => v.previewUrl)).toEqual([null, null, null]);
  });

  it.each([undefined, "", "   ", "short", "has a space in it 1234567890", "x".repeat(501)])(
    "refuses key %j before any fetch",
    async (apiKey) => {
      expect((await POST(req("POST", { apiKey }), ctx())).status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mem.read(SECRET)).toBeUndefined();
    },
  );

  it.each(["null", "[]", "not json"])("a body of %s is a 400, not a crash, on POST and PATCH", async (raw) => {
    for (const [handler, method] of [[POST, "POST"], [PATCH, "PATCH"]] as const) {
      const r = new Request(`${APP}/x`, { method, headers: { "x-user-uid": "admin1" }, body: raw });
      expect((await handler(r, ctx())).status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a key ElevenLabs rejects is never stored and creates nothing", async () => {
    const res = await connect(`el_bad_${"c".repeat(24)}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/rejected that key/);
    expect(elCalls("POST", "/v1/convai/agents")).toHaveLength(0);
    expect(mem.read(SECRET)).toBeUndefined();
    expect(mem.read("subAccounts/sa1")).not.toHaveProperty("webVoiceMeta");
  });

  it("ElevenLabs unreachable is 502 and stores nothing", async () => {
    fetchMock.mockImplementation(async (input) => {
      // A transport error that echoes the request header must not reach the response.
      if (String(input).startsWith(EL)) throw new Error(`connect ETIMEDOUT (xi-api-key: ${KEY})`);
      return new Response("", { status: 200 });
    });
    const res = await connect();
    expect(res.status).toBe(502);
    expect((await body(res)).error).toContain("[redacted]");
    expect(mem.read(SECRET)).toBeUndefined();
  });

  it("without a public https app URL the probed key is kept but the agent is not provisioned", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
    const out = await body(await connect());
    expect(elCalls("POST", "/v1/convai/agents")).toHaveLength(0);
    expect(out.meta).toMatchObject({ ready: false, lastError: expect.stringMatching(/public https deployment/) });
    expect(mem.read(SECRET)).toMatchObject({ apiKey: KEY, agentId: null });
  });

  it("an agent-create error echoing the agent body is redacted before it reaches the meta", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "POST") {
        const b = JSON.parse(String(init.body)) as AgentBody;
        return json(422, { detail: `bad url ${b.conversation_config.agent.prompt.custom_llm.url}` });
      }
      return fakeFetch(input, init);
    });
    const out = await body(await connect());
    noLeak(mem.read("subAccounts/sa1"));
    expect(out.meta).toMatchObject({ lastError: "bad url [url]" });
  });

  it("an agent id ElevenLabs returns that is not a plain id is never stored", async () => {
    fetchMock.mockImplementation(async (input, init) =>
      init?.method === "POST" ? json(200, { agent_id: "../voices" }) : fakeFetch(input, init),
    );
    const out = await body(await connect());
    expect(out.meta).toMatchObject({ lastError: "ElevenLabs didn't return an agent id." });
    expect(mem.read(SECRET)?.agentId).toBeNull();
  });

  it("re-keying keeps settings, mints a NEW endpoint secret, provisions on the new account, then deletes the old agent with the OLD key", async () => {
    await connect();
    const first = mem.read(SECRET)!;
    calls = [];
    await PATCH(req("PATCH", { greeting: "Howzit" }), ctx());
    calls = [];

    expect((await connect(KEY2)).status).toBe(200);
    const second = mem.read(SECRET)!;
    expect(second).toMatchObject({ apiKey: KEY2, agentId: "agent2", greeting: "Howzit" });
    // An old agent that survives its delete must not still reach our endpoint.
    expect(second.endpointSecret).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(second.endpointSecret).not.toBe(first.endpointSecret);
    const created = elCalls("POST", "/v1/convai/agents/create")[0].body as AgentBody;
    expect(created.conversation_config.agent.prompt.custom_llm.url).toBe(
      `${APP}/api/webhooks/elevenlabs/llm/sa1/${second.endpointSecret}`,
    );
    expect(second.rev).not.toBe(first.rev);
    const del = elCalls("DELETE", "/v1/convai/agents/agent1");
    expect(del).toHaveLength(1);
    expect(del[0].key).toBe(KEY);
    // The old agent goes only after the new connection is committed.
    expect(calls.indexOf(del[0])).toBeGreaterThan(calls.indexOf(elCalls("POST", "/v1/convai/agents/create")[0]));
    expect(mem.read("subAccounts/sa1")?.webVoiceMeta).toMatchObject({ keyLast4: "bbbb" });
  });

  it("a rival write committed mid-provisioning wins: 409, nothing overwritten, our new agent deleted", async () => {
    const rival = { apiKey: KEY2, endpointSecret: "r".repeat(32), agentId: "agentRival", rev: "rival" };
    onCreate = () => mem.seed(SECRET, rival);
    const res = await connect();
    expect(res.status).toBe(409);
    expect(mem.read(SECRET)).toEqual(rival);
    expect(mem.read("subAccounts/sa1")).not.toHaveProperty("webVoiceMeta");
    expect(elCalls("DELETE", "/v1/convai/agents/agent1")).toHaveLength(1);
    expect(agents.has("agent1")).toBe(false);
  });

  it("a disconnect then reconnect mid-save is still a conflict (revisions never repeat)", async () => {
    await connect();
    const before = mem.read(SECRET)!;
    // A rival disconnect + reconnect leaves a doc with the same key but a new rev.
    onCreate = null;
    let patched = false;
    fetchMock.mockImplementation(async (input, init) => {
      const res = await fakeFetch(input, init);
      if (!patched && init?.method === "PATCH") {
        patched = true;
        mem.seed(SECRET, { ...before, rev: "after-reconnect" });
      }
      return res;
    });
    expect((await PATCH(req("PATCH", { greeting: "Hello" }), ctx())).status).toBe(409);
    expect(mem.read(SECRET)).toMatchObject({ greeting: before.greeting, rev: "after-reconnect" });
  });
});

describe("PATCH — settings", () => {
  it("needs a connection first", async () => {
    const res = await PATCH(req("PATCH", { greeting: "Hi" }), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Connect an ElevenLabs key first/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks an optional transaction guard before committing settings", async () => {
    await connect();
    const before = mem.read(SECRET);
    const guard = vi.fn(async () => { throw new Error("handoff moved on"); });
    await expect(updateWebVoiceSettings({ subAccountId: "sa1", patch: { enabled: false }, transactionGuard: guard }))
      .rejects.toThrow("handoff moved on");
    expect(guard).toHaveBeenCalledOnce();
    expect(mem.read(SECRET)).toMatchObject({ enabled: before?.enabled, rev: before?.rev });
  });

  it.each([
    [{ language: "xx" }, /language/],
    [{ voiceId: "../../etc" }, /voice/],
    [{ greeting: "   " }, /greeting/],
    [{ maxCallSeconds: "abc" }, /number/],
  ])("refuses %j with nothing synced or written", async (patch, msg) => {
    await connect();
    const before = mem.read(SECRET);
    calls = [];
    const res = await PATCH(req("PATCH", patch), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(msg);
    expect(calls).toHaveLength(0);
    expect(mem.read(SECRET)).toEqual(before);
  });

  it("clamps, re-syncs the existing agent and mirrors the meta", async () => {
    await connect();
    calls = [];
    const out = await body(
      await PATCH(req("PATCH", { greeting: "Hello there", maxCallSeconds: 99999, dailyMinuteCap: 1, language: "es" }), ctx()),
    );
    expect(elCalls("PATCH", "/v1/convai/agents/agent1")).toHaveLength(1);
    expect(out.meta).toMatchObject({ greeting: "Hello there", maxCallSeconds: 1800, dailyMinuteCap: 5, language: "es", ready: true });
    expect(mem.read(SECRET)).toMatchObject({ greeting: "Hello there", maxCallSeconds: 1800, agentId: "agent1" });
    const agent = elCalls("PATCH", "/v1/convai/agents/agent1")[0].body as AgentBody;
    expect(agent.conversation_config.tts.model_id).toBe("eleven_flash_v2_5");
  });

  it("an agent deleted on the ElevenLabs side is re-created", async () => {
    await connect();
    agents.delete("agent1");
    await PATCH(req("PATCH", { greeting: "Again" }), ctx());
    expect(mem.read(SECRET)?.agentId).toBe("agent2");
    expect(mem.read("subAccounts/sa1")?.webVoiceMeta).toMatchObject({ ready: true, lastError: null });
  });

  it("an ElevenLabs failure is recorded on the meta, not thrown, and the last good settings stay stored", async () => {
    await connect();
    const before = mem.read(SECRET)!;
    fetchMock.mockImplementation(async (input, init) =>
      init?.method === "PATCH" ? json(422, { detail: [{ msg: "voice not allowed" }] }) : fakeFetch(input, init),
    );
    const out = await body(await PATCH(req("PATCH", { greeting: "Again", voiceId: "cloned0001" }), ctx()));
    expect(out.meta).toMatchObject({ ready: false, lastError: "voice not allowed", greeting: before.greeting, voiceId: "premade001" });
    // The live agent still runs the old settings, so the stored ones match it.
    expect(mem.read(SECRET)).toMatchObject({ greeting: before.greeting, voiceId: "premade001", agentId: "agent1" });
  });

  it("returns connectedAt as an ISO string after a save over a stored Timestamp", async () => {
    await connect();
    const sub = mem.read("subAccounts/sa1")!;
    const connectedAt = Timestamp.fromDate(new Date("2026-10-01T08:00:00Z"));
    mem.seed("subAccounts/sa1", { ...sub, webVoiceMeta: { ...(sub.webVoiceMeta as object), connectedAt } });
    const out = await body(await PATCH(req("PATCH", { greeting: "Hi" }), ctx()));
    expect((out.meta as Record<string, unknown>).connectedAt).toBe("2026-10-01T08:00:00.000Z");
  });

  it("an array body on a CONNECTED account is a 400 and syncs nothing", async () => {
    await connect();
    calls = [];
    const res = await PATCH(new Request(`${APP}/x`, { method: "PATCH", headers: { "x-user-uid": "admin1" }, body: "[]" }), ctx());
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("a stored agent id that is not a plain id never reaches a request path", async () => {
    await connect();
    mem.seed(SECRET, { ...mem.read(SECRET)!, agentId: ".." });
    calls = [];
    const out = await body(await PATCH(req("PATCH", { greeting: "Hi" }), ctx()));
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    expect(out.meta).toMatchObject({ lastError: "That ElevenLabs id isn't valid." });
  });

  it("A1: of two racing saves, the loser re-syncs the live agent to the winner's settings", async () => {
    expect((await connect()).status).toBe(200);
    // Both saves read the same rev; A's PATCH reaches ElevenLabs only after B committed.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let patches = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "PATCH" && ++patches === 1) await held;
      return fakeFetch(input, init);
    });
    const a = PATCH(req("PATCH", { greeting: "AAA" }), ctx());
    await new Promise((r) => setTimeout(r, 50));
    const rb = await PATCH(req("PATCH", { greeting: "BBB" }), ctx());
    release();
    const ra = await a;
    expect([ra.status, rb.status]).toEqual([409, 200]);
    expect(mem.read(SECRET)?.greeting).toBe("BBB");
    const last = calls.filter((c) => c.method === "PATCH").at(-1)!.body as {
      conversation_config: { agent: { first_message: string } };
    };
    expect(last.conversation_config.agent.first_message).toBe("BBB");
  });

  it("A1: a loser whose rival moved to a different agent leaves that agent alone", async () => {
    expect((await connect()).status).toBe(200);
    const rival = { ...mem.read(SECRET)!, apiKey: KEY2, agentId: "agentRival", rev: "rival" };
    agents.set("agentRival", KEY2);
    let seeded = false;
    fetchMock.mockImplementation(async (input, init) => {
      const res = await fakeFetch(input, init);
      if (init?.method === "PATCH" && !seeded) {
        seeded = true;
        mem.seed(SECRET, rival);
      }
      return res;
    });
    expect((await PATCH(req("PATCH", { greeting: "AAA" }), ctx())).status).toBe(409);
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.url)).toEqual([`${EL}/v1/convai/agents/agent1`]);
    expect(mem.read(SECRET)).toEqual(rival);
  });

  it("B1: a save committed while the loser's re-sync PATCH is in flight is re-applied — the agent ends on CCC", async () => {
    expect((await connect()).status).toBe(200);
    let releaseA!: () => void;
    const heldA = new Promise<void>((r) => (releaseA = r));
    let releaseRestore!: () => void;
    const heldRestore = new Promise<void>((r) => (releaseRestore = r));
    let restoreStarted!: () => void;
    const restoreSeen = new Promise<void>((r) => (restoreStarted = r));
    let patches = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "PATCH") {
        const n = ++patches;
        if (n === 1) await heldA; // A's own PATCH
        if (n === 3) {
          restoreStarted(); // A's re-sync PATCH, carrying B's settings
          await heldRestore;
        }
      }
      return fakeFetch(input, init);
    });
    const a = PATCH(req("PATCH", { greeting: "AAA" }), ctx());
    await new Promise((r) => setTimeout(r, 50));
    expect((await PATCH(req("PATCH", { greeting: "BBB" }), ctx())).status).toBe(200);
    releaseA();
    await restoreSeen;
    expect((await PATCH(req("PATCH", { greeting: "CCC" }), ctx())).status).toBe(200);
    releaseRestore();
    expect((await a).status).toBe(409);
    expect(mem.read(SECRET)?.greeting).toBe("CCC");
    expect(greetingOf(calls.filter((c) => c.method === "PATCH").at(-1)!)).toBe("CCC");
  });

  it("B1: settings that keep changing under the re-sync stop after 3 passes and are recorded", async () => {
    expect((await connect()).status).toBe(200);
    let releaseA!: () => void;
    const heldA = new Promise<void>((r) => (releaseA = r));
    let patches = 0;
    let churn = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "PATCH") {
        const n = ++patches;
        if (n === 1) await heldA;
        // Every re-sync PATCH (n ≥ 3) sees another save commit underneath it.
        if (n >= 3) mem.seed(SECRET, { ...mem.read(SECRET)!, greeting: `G${++churn}`, rev: `churn${churn}` });
      }
      return fakeFetch(input, init);
    });
    const a = PATCH(req("PATCH", { greeting: "AAA" }), ctx());
    await new Promise((r) => setTimeout(r, 50));
    expect((await PATCH(req("PATCH", { greeting: "BBB" }), ctx())).status).toBe(200);
    releaseA();
    expect((await a).status).toBe(409);
    expect(patches).toBe(2 + 3); // A, B, then exactly three re-sync passes
    expect(mem.read("subAccounts/sa1")?.webVoiceMeta).toMatchObject({
      greeting: "G3",
      lastError: expect.stringMatching(/may not match/),
    });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("agent restore gave up"))).toBe(true);
  });

  it("a non-409 commit failure after PATCHing the live agent puts the agent back to the stored settings", async () => {
    expect((await connect()).status).toBe(200);
    const stored = mem.read(SECRET)!.greeting;
    calls = [];
    vi.spyOn(storeDb, "runTransaction").mockRejectedValueOnce(new Error("firestore unavailable"));
    expect((await PATCH(req("PATCH", { greeting: "New" }), ctx())).status).toBe(500);
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches.map(greetingOf)).toEqual(["New", stored]);
    expect(mem.read(SECRET)?.greeting).toBe(stored);
  });

  it("a restore that itself cannot read Firestore never replaces the commit's error", async () => {
    expect((await connect()).status).toBe(200);
    vi.spyOn(storeDb, "runTransaction").mockRejectedValueOnce(new Error("firestore unavailable"));
    const doc = storeDb.doc;
    let failReads = false;
    vi.spyOn(storeDb, "doc").mockImplementation((path: string) => {
      const ref = doc(path);
      if (failReads && path.endsWith("/private/webVoiceConnection")) {
        return { ...ref, get: () => Promise.reject(new Error("read failed")) } as typeof ref;
      }
      return ref;
    });
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "PATCH") failReads = true;
      return fakeFetch(input, init);
    });
    const res = await PATCH(req("PATCH", { greeting: "New" }), ctx());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Couldn't save voice settings.");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("agent restore failed"))).toBe(true);
  });

  it("A1: a failed re-sync after a lost race is logged and recorded on the meta", async () => {
    expect((await connect()).status).toBe(200);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let patches = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "PATCH") {
        const n = ++patches;
        if (n === 1) await held;
        if (n === 3) throw new Error("socket hang up");
      }
      return fakeFetch(input, init);
    });
    const a = PATCH(req("PATCH", { greeting: "AAA" }), ctx());
    await new Promise((r) => setTimeout(r, 50));
    await PATCH(req("PATCH", { greeting: "BBB" }), ctx());
    release();
    expect((await a).status).toBe(409);
    expect(mem.read(SECRET)?.greeting).toBe("BBB");
    expect(mem.read("subAccounts/sa1")?.webVoiceMeta).toMatchObject({ greeting: "BBB", lastError: expect.stringMatching(/may not match/) });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("agent restore failed"))).toBe(true);
  });

  it("A2: ElevenLabs error text echoing the endpoint secret or the key is redacted before it is stored or returned", async () => {
    expect((await connect()).status).toBe(200);
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "PATCH") {
        const b = JSON.parse(String(init.body)) as AgentBody;
        const key = (init.headers as Record<string, string>)["xi-api-key"];
        return json(422, { detail: `Custom LLM URL ${b.conversation_config.agent.prompt.custom_llm.url} unreachable for ${key}` });
      }
      return fakeFetch(input, init);
    });
    const res = await PATCH(req("PATCH", { greeting: "Hello" }), ctx());
    expect(res.status).toBe(200);
    const out = await body(res);
    const meta = mem.read("subAccounts/sa1")?.webVoiceMeta;
    noLeak(meta);
    expect(String((out.meta as Record<string, unknown>).lastError)).toContain("[redacted]");
  });

  it("B2: a truncated (pydantic-style) echo of the URL leaks no run of the endpoint secret", async () => {
    expect((await connect()).status).toBe(200);
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "PATCH") {
        const url = (JSON.parse(String(init.body)) as AgentBody).conversation_config.agent.prompt.custom_llm.url;
        // No scheme, so the URL rule cannot catch it: only the fragment rule can.
        return json(422, {
          detail: `Invalid custom_llm url '...${url.slice(-26)}' and ${url.slice(-30, -12)}, near ${url.slice(-20, -11)}`,
        });
      }
      return fakeFetch(input, init);
    });
    await PATCH(req("PATCH", { greeting: "Hello" }), ctx());
    const secret = mem.read(SECRET)?.endpointSecret as string;
    const lastError = String((mem.read("subAccounts/sa1")?.webVoiceMeta as Record<string, unknown>).lastError);
    // The last run is 9 characters: just over the fragment length.
    expect(lastError).toBe("Invalid custom_llm url '...[redacted]' and [redacted], near [redacted]");
    for (let i = 0; i + 8 <= secret.length; i++) expect(lastError).not.toContain(secret.slice(i, i + 8));
  });

  it("B2: a URL echoed with its secret cut below the fragment length is still removed", async () => {
    expect((await connect()).status).toBe(200);
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "PATCH") {
        const url = (JSON.parse(String(init.body)) as AgentBody).conversation_config.agent.prompt.custom_llm.url;
        return json(422, { detail: `Unreachable: ${url.slice(0, url.length - 26)}... (timeout)` });
      }
      return fakeFetch(input, init);
    });
    await PATCH(req("PATCH", { greeting: "Hello" }), ctx());
    const lastError = String((mem.read("subAccounts/sa1")?.webVoiceMeta as Record<string, unknown>).lastError);
    expect(lastError).toBe("Unreachable: [url] (timeout)");
  });
});

describe("GET", () => {
  it("returns gate, meta and (asked) the live voices, never the key", async () => {
    await connect();
    const out = await body(await GET(req("GET", undefined, "admin1", "?voices=1"), ctx()));
    expect(out).toMatchObject({ gateOn: true, webChatGateOn: true, voicesError: null });
    expect((out.meta as Record<string, unknown>).keyLast4).toBe("aaaa");
    expect((out.voices as unknown[]).length).toBe(5);
  });

  it("returns today's and this month's minutes, and a preview widget token only while visitors could get one", async () => {
    vi.stubEnv("AUTOMATIONS_TOKEN_SECRET", "test-secret-at-least-16-chars");
    await connect();
    mem.seed(USAGE, {
      day: new Date().toISOString().slice(0, 10),
      month: new Date().toISOString().slice(0, 7),
      secondsToday: 90,
      secondsThisMonth: 600,
      pending: { conv_000001: { sessionId: "s", grantId: "g", startedAtMs: Date.now() } },
    });
    const on = await body(await GET(req("GET"), ctx()));
    expect(on.usage).toEqual({ secondsToday: 90, secondsThisMonth: 600, activeNow: 1 });
    expect(verifyWidgetToken(on.previewToken, "sa1")).toBe(true);

    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), webVoiceEnabledByAgency: false });
    const off = await body(await GET(req("GET"), ctx()));
    expect(off.previewToken).toBeNull();
  });

  it("returns no usage before a key is connected", async () => {
    expect((await body(await GET(req("GET"), ctx()))).usage).toBeNull();
  });

  it.each([
    ["a Firestore Timestamp", Timestamp.fromDate(new Date("2026-10-01T08:00:00Z"))],
    ["a Date", new Date("2026-10-01T08:00:00Z")],
  ])("returns connectedAt stored as %s as an ISO string", async (_n, connectedAt) => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", webVoiceEnabledByAgency: true, webVoiceMeta: { ready: false, connectedAt } });
    const out = await body(await GET(req("GET"), ctx()));
    expect((out.meta as Record<string, unknown>).connectedAt).toBe("2026-10-01T08:00:00.000Z");
  });
});

describe("DELETE — disconnect", () => {
  it("deletes the secret and usage docs, clears the meta, then deletes the agent with the stored key", async () => {
    await connect();
    mem.seed(USAGE, { day: "2026-10-12", secondsToday: 10 });
    calls = [];
    expect((await DELETE(req("DELETE"), ctx())).status).toBe(200);
    expect(mem.read(SECRET)).toBeUndefined();
    expect(mem.read(USAGE)).toBeUndefined();
    expect(mem.read("subAccounts/sa1")?.webVoiceMeta).toBeNull();
    expect(elCalls("DELETE", "/v1/convai/agents/agent1").map((c) => c.key)).toEqual([KEY]);
  });

  it("a secret doc too damaged to parse still has its agent deleted", async () => {
    mem.seed(SECRET, { apiKey: KEY, agentId: "agent7", rev: "r1" }); // no endpointSecret
    agents.set("agent7", KEY);
    const res = await DELETE(req("DELETE"), ctx());
    expect(await body(res)).toEqual({ ok: true });
    expect(agents.has("agent7")).toBe(false);
    expect(mem.read(SECRET)).toBeUndefined();
  });

  it("an agent id stored without a key cannot be deleted, so the response warns", async () => {
    mem.seed(SECRET, { agentId: "agent7", rev: "r1" });
    agents.set("agent7", KEY);
    const out = await body(await DELETE(req("DELETE"), ctx()));
    expect(out.warning).toMatch(/could not be removed/);
    expect(mem.read(SECRET)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("no agent stored at all is a clean disconnect", async () => {
    mem.seed(SECRET, { apiKey: KEY, rev: "r1" });
    expect(await body(await DELETE(req("DELETE"), ctx()))).toEqual({ ok: true });
  });

  it("an agent already gone on ElevenLabs (404) counts as removed", async () => {
    await connect();
    agents.delete("agent1");
    expect(await body(await DELETE(req("DELETE"), ctx()))).toEqual({ ok: true });
  });

  it("a stored agent id that is not a plain id is never put in a DELETE path", async () => {
    mem.seed(SECRET, { apiKey: KEY, agentId: "../voices", endpointSecret: "s".repeat(32), rev: "r1" });
    const out = await body(await DELETE(req("DELETE"), ctx()));
    expect(out.warning).toBeDefined();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  it("a failed remote delete never blocks disconnect and logs only a message", async () => {
    await connect();
    const leaky = Object.assign(new Error("boom"), { config: { headers: { "xi-api-key": KEY } } });
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "DELETE") throw leaky;
      return fakeFetch(input, init);
    });
    const res = await DELETE(req("DELETE"), ctx());
    expect(res.status).toBe(200);
    expect((await body(res)).warning).toMatch(/could not be removed from your ElevenLabs account/);
    expect(mem.read(SECRET)).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    for (const args of warn.mock.calls) {
      for (const a of args) expect(typeof a).toBe("string");
      expect(args.join(" ")).not.toContain(KEY);
    }
  });
});

describe("logging", () => {
  it("an unexpected failure is a 500 that logs the message only", async () => {
    vi.spyOn(storeDb, "runTransaction").mockRejectedValue(
      Object.assign(new Error("firestore down"), { metadata: { key: KEY } }),
    );
    const res = await connect();
    expect(res.status).toBe(500);
    // The agent this request created is not left on the client's account.
    expect(elCalls("POST", "/v1/convai/agents/create")).toHaveLength(1);
    expect(agents.has("agent1")).toBe(false);
    expect(error).toHaveBeenCalled();
    for (const args of error.mock.calls) for (const a of args) expect(typeof a).toBe("string");
  });
});
