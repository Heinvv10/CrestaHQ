import { expect, it, vi } from "vitest";

/**
 * After a sync responds: auto-reply for EVERY synced tenant first, then
 * sentiment for all of them, under the request's one deadline
 * (AUTO_REPLY_V1_PLAN.md "Ordering in after()").
 */

const order = vi.hoisted(() => [] as string[]);
vi.mock("./auto-reply/run", () => ({
  autoReplyAfterSync: async (sa: string, startedAt: Date, deadline: number) =>
    void order.push(`auto:${sa}:${startedAt.toISOString()}:${deadline}`),
}));
vi.mock("./sentiment-after", () => ({
  afterResponse: (work: () => Promise<unknown>) => void work(),
  classifySyncedRuns: async (runs: Array<{ subAccountId: string }>, deadline: number) =>
    void order.push(`sentiment:${runs.map((r) => r.subAccountId).join(",")}:${deadline}`),
}));

import { runAfterSync } from "./after-sync";

it("runs auto-reply for every tenant before any sentiment, sharing the deadline and each run's start", async () => {
  const a = new Date("2026-09-26T10:00:00Z");
  const b = new Date("2026-09-26T10:00:05Z");
  await runAfterSync(
    [{ subAccountId: "sa_1", created: 1, updated: 0, startedAt: a }, { subAccountId: "sa_2", created: 0, updated: 0, startedAt: b }],
    999,
  );
  expect(order).toEqual([`auto:sa_1:${a.toISOString()}:999`, `auto:sa_2:${b.toISOString()}:999`, "sentiment:sa_1,sa_2:999"]);
});
