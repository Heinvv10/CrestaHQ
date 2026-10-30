import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/sub-accounts/[id]/google/status — the one deployment fact the
 * Google Business page needs before it can offer Connect: is Google usable
 * here at all. Member-readable, non-secret.
 */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/google-oauth-harness")).adminMock(),
);

import { SUB, request, resetHarness } from "@/test/google-oauth-harness";
import { enableFakeMode } from "@/test/gbp-route-harness";
import { GET } from "./route";

const ORIGINAL = { ...process.env };

async function status(uid = "uid_collab") {
  const res = await GET(request(`http://app.local/api/sub-accounts/${SUB}/google/status`, uid), {
    params: Promise.resolve({ id: SUB }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => resetHarness());
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("google status", () => {
  it("tells any member whether Google is configured, and nothing else", async () => {
    expect(await status()).toEqual({ status: 200, body: { configured: true } });
    delete process.env.GOOGLE_CLIENT_SECRET;
    expect(await status()).toEqual({ status: 200, body: { configured: false } });
  });

  it("reports a refused fake as not configured", async () => {
    enableFakeMode();
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.crestahq.com";
    expect((await status()).body).toEqual({ configured: false });
  });

  it("refuses a non-member", async () => {
    expect((await status("uid_other_admin")).status).toBe(403);
  });
});
