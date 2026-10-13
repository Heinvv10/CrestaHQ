import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Contract test for the two ElevenLabs reads Web Voice metering relies on.
 * The bodies below are written from ElevenLabs' published API reference for
 * `GET /v1/convai/conversations/{id}` and `GET /v1/convai/conversations`
 * (ElevenAgents), with the fields it documents around the ones we read. They
 * are ASSUMED, not recorded from a live account: no key has been connected
 * (docs/features/web-voice.md). When the first live walk records a real
 * response, replace these with it — if this test then fails, metering would
 * have been wrong.
 */

vi.mock("server-only", () => ({}));

const { getConversation, listConversations } = await import("./elevenlabs");

const CONVERSATION_DETAIL = {
  agent_id: "agent_7101k5abcdefghijklmnopqrst",
  conversation_id: "conv_8401k5abcdefghijklmnopqrst",
  status: "done",
  user_id: null,
  transcript: [{ role: "agent", message: "Hi there!", time_in_call_secs: 0 }],
  metadata: {
    start_time_unix_secs: 1760342400,
    accepted_time_unix_secs: 1760342401,
    call_duration_secs: 187,
    cost: 512,
    termination_reason: "Client disconnected",
    main_language: "en",
  },
  analysis: null,
  conversation_initiation_client_data: {
    custom_llm_extra_body: { token: "s1.redacted" },
  },
  has_audio: true,
  has_user_audio: true,
  has_response_audio: true,
};

const CONVERSATION_LIST = {
  conversations: [
    {
      agent_id: "agent_7101k5abcdefghijklmnopqrst",
      agent_name: "Acme — website voice",
      conversation_id: "conv_8401k5abcdefghijklmnopqrst",
      start_time_unix_secs: 1760342400,
      call_duration_secs: 187,
      message_count: 14,
      status: "done",
      call_successful: "success",
      transcript_summary: null,
      call_summary_title: null,
      direction: "inbound",
    },
    {
      agent_id: "agent_7101k5abcdefghijklmnopqrst",
      agent_name: "Acme — website voice",
      conversation_id: "conv_8401k5zyxwvutsrqponmlkjih",
      start_time_unix_secs: 1760342990,
      call_duration_secs: 0,
      message_count: 0,
      status: "in-progress",
      call_successful: "unknown",
      transcript_summary: null,
      call_summary_title: null,
      direction: "inbound",
    },
  ],
  next_cursor: "eyJwYWdlIjoyfQ",
  has_more: true,
};

afterEach(() => vi.unstubAllGlobals());

function answer(body: unknown) {
  const fetchMock = vi.fn(async (_input: string | URL) => Response.json(body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ElevenLabs conversation reads (ASSUMED shapes)", () => {
  it("reads agent, status, duration and start time from a conversation", async () => {
    answer(CONVERSATION_DETAIL);
    expect(await getConversation("key", "conv_8401k5abcdefghijklmnopqrst")).toEqual({
      agentId: "agent_7101k5abcdefghijklmnopqrst",
      status: "done",
      durationSeconds: 187,
      startTimeUnixSecs: 1760342400,
    });
  });

  it("lists an agent's conversations with the filters and paging metering expects", async () => {
    const fetchMock = answer(CONVERSATION_LIST);
    const page = await listConversations("key", "agent_7101k5abcdefghijklmnopqrst", 1760342000.9, "eyJwYWdlIjoxfQ");
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/v1/convai/conversations");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      agent_id: "agent_7101k5abcdefghijklmnopqrst",
      call_start_after_unix: "1760342000",
      page_size: "100",
      cursor: "eyJwYWdlIjoxfQ",
    });
    expect(page).toEqual({
      hasMore: true,
      nextCursor: "eyJwYWdlIjoyfQ",
      conversations: [
        {
          conversationId: "conv_8401k5abcdefghijklmnopqrst",
          agentId: "agent_7101k5abcdefghijklmnopqrst",
          status: "done",
          durationSeconds: 187,
          startTimeUnixSecs: 1760342400,
        },
        {
          conversationId: "conv_8401k5zyxwvutsrqponmlkjih",
          agentId: "agent_7101k5abcdefghijklmnopqrst",
          status: "in-progress",
          durationSeconds: 0,
          startTimeUnixSecs: 1760342990,
        },
      ],
    });
  });

  it("throws on a list body without a conversations array, and nulls a malformed item", async () => {
    answer({ items: [], has_more: false });
    await expect(listConversations("key", "agent_1", 0, null)).rejects.toThrow(/no conversations array/);
    answer({ conversations: [{ conversation_id: "../x", start_time_unix_secs: -5, call_duration_secs: "9" }], has_more: false });
    expect((await listConversations("key", "agent_1", 0, null)).conversations).toEqual([
      { conversationId: null, agentId: null, status: null, durationSeconds: null, startTimeUnixSecs: null },
    ]);
  });
});
