import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/cron/ai-models — the daily catalog refresh. Real QStash signature
 * verification (test signing keys); OpenRouter's list is a stubbed fetch.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

const KEY = "sig_test_current_key_for_ai_models";
process.env.QSTASH_CURRENT_SIGNING_KEY = KEY;
process.env.QSTASH_NEXT_SIGNING_KEY = "sig_test_next_key_for_ai_models";

import { signQStashBody } from "../../../../../e2e/lib/qstash";
import { mem } from "@/test/gbp-sync-store";
import { POST } from "./route";

const URL_ = "http://127.0.0.1:3100/api/cron/ai-models";
const list = Array.from({ length: 60 }, (_, i) => ({ id: `a/m${i}`, name: `M${i}`, pricing: { prompt: "0", completion: "0" } }));
const fetchMock = vi.fn(async () => Response.json({ data: list }));

function cron(signature?: string | null) {
  const body = "{}";
  const sig = signature === undefined ? signQStashBody(URL_, body) : signature;
  return POST(new Request(URL_, { method: "POST", headers: sig ? { "upstash-signature": sig } : {}, body }));
}

beforeEach(() => {
  mem.clear();
  fetchMock.mockClear();
  process.env.QSTASH_CURRENT_SIGNING_KEY = KEY;
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("cron/ai-models", () => {
  it("refuses an unsigned or badly signed call without fetching", async () => {
    expect((await cron(null)).status).toBe(401);
    expect((await cron("bogus")).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes the cache even when it is fresh (forced)", async () => {
    mem.seed("appConfig/aiModels", { models: [], fetchedAt: Date.now(), lastAttemptAt: Date.now() });
    const res = await cron();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, models: 60 });
    expect((mem.read("appConfig/aiModels")?.models as unknown[]).length).toBe(60);
  });
});
