import { describe, expect, it, vi } from "vitest";

const get = vi.hoisted(() => vi.fn());
const chain = vi.hoisted(() => ({
  collection: vi.fn(),
  where: vi.fn(),
  orderBy: vi.fn(),
  limit: vi.fn(),
  get,
}));
chain.collection.mockReturnValue(chain);
chain.where.mockReturnValue(chain);
chain.orderBy.mockReturnValue(chain);
chain.limit.mockReturnValue(chain);

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({ doc: () => chain }),
}));

const { GET } = await import("./route");

describe("web-chat poll voice projection", () => {
  it("projects only the fixed voice discriminator for outbound rows", async () => {
    get.mockResolvedValueOnce({
      docs: [
        {
          id: "voice-1",
          data: () => ({
            direction: "outbound",
            body: "spoken answer",
            via: "voice",
            createdAt: { toMillis: () => 101 },
          }),
        },
        {
          id: "typed-1",
          data: () => ({
            direction: "outbound",
            body: "typed answer",
            via: "untrusted-value",
            createdAt: { toMillis: () => 102 },
          }),
        },
      ],
    });

    const response = await GET(
      new Request(
        "https://app.test/api/web-chat/poll?sa=sa1&sessionId=abcdefghijklmnop&after=0"
      )
    );
    const body = (await response.json()) as {
      messages: Record<string, unknown>[];
    };

    expect(body.messages).toEqual([
      { id: "voice-1", body: "spoken answer", via: "voice", createdAtMs: 101 },
      { id: "typed-1", body: "typed answer", createdAtMs: 102 },
    ]);
  });
});
