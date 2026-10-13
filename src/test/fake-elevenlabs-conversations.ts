import { vi } from "vitest";

/**
 * `fetch` answering as ElevenLabs' conversation endpoints, for the Web Voice
 * accounting tests: `GET /v1/convai/conversations/{id}` from `byId` (404 when
 * absent) and the agent's list `GET /v1/convai/conversations?agent_id=…`
 * from `listed`, filtered by `agent_id` and `call_start_after_unix` as
 * ElevenLabs is assumed to filter them. Every requested id is recorded in
 * `lookups`, every list call in `listCalls`.
 */

const BASE = "https://api.elevenlabs.io/v1/convai/conversations";

export type FakeConversation = {
  agent_id?: string;
  status?: string;
  start_time_unix_secs?: number;
  call_duration_secs?: number;
};

export function fakeElevenLabsConversations() {
  const state = {
    /** Conversation lookups: id → HTTP status + conversation (status 200). */
    byId: new Map<string, { status: number; conv?: FakeConversation }>(),
    /** The agent's conversation list: id → conversation. */
    listed: new Map<string, FakeConversation>(),
    /** When set, the list endpoint answers with this HTTP status instead. */
    listStatus: null as number | null,
    /** When true, the list endpoint claims more pages and gives no cursor. */
    listTruncated: false,
    lookups: [] as string[],
    listCalls: [] as string[],
  };
  const nowSecs = () => Math.floor(Date.now() / 1000);
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.startsWith(`${BASE}?`)) {
      state.listCalls.push(url);
      if (state.listStatus) return Response.json({ detail: "list failed" }, { status: state.listStatus });
      const q = new URL(url).searchParams;
      const after = Number(q.get("call_start_after_unix"));
      const conversations = [...state.listed.entries()]
        .filter(([, c]) => c.agent_id === q.get("agent_id") && (c.start_time_unix_secs ?? 0) >= after)
        .map(([id, c]) => ({ conversation_id: id, ...c }));
      return Response.json({ conversations, has_more: state.listTruncated, next_cursor: null });
    }
    if (!url.startsWith(`${BASE}/`)) throw new Error(`unexpected fetch ${url}`);
    const id = url.slice(BASE.length + 1);
    state.lookups.push(id);
    const hit = state.byId.get(id);
    if (!hit) return Response.json({ detail: "Conversation not found" }, { status: 404 });
    if (hit.status !== 200) return Response.json({ detail: "boom" }, { status: hit.status });
    const c = hit.conv ?? {};
    return Response.json({
      agent_id: c.agent_id,
      status: c.status,
      metadata: { call_duration_secs: c.call_duration_secs, start_time_unix_secs: c.start_time_unix_secs },
    });
  });

  /** A conversation on `agentId`, started now unless told otherwise. */
  const conv = (over: FakeConversation = {}): FakeConversation => ({
    agent_id: "agent1",
    status: "in-progress",
    start_time_unix_secs: nowSecs(),
    ...over,
  });
  return {
    state,
    fetchMock,
    conv,
    live: (id: string, over: FakeConversation = {}) => state.byId.set(id, { status: 200, conv: conv(over) }),
    done: (id: string, secs: number, over: FakeConversation = {}) =>
      state.byId.set(id, { status: 200, conv: conv({ status: "done", call_duration_secs: secs, ...over }) }),
  };
}
