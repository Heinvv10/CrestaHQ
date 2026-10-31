import { webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { newRequestId } from "./buy-button";
import { isBuyRequestId } from "@/lib/server/product-buy-session";

/** The buy button's per-page-load request id is a v4 UUID the session route
 *  accepts, with or without `crypto.randomUUID` (older or insecure contexts). */

afterEach(() => vi.unstubAllGlobals());

it("uses randomUUID when present", () => {
  expect(isBuyRequestId(newRequestId())).toBe(true);
});

it("falls back to getRandomValues when randomUUID is missing", () => {
  vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array) => webcrypto.getRandomValues(a) });
  const ids = Array.from({ length: 50 }, newRequestId);
  for (const id of ids) {
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(isBuyRequestId(id)).toBe(true);
  }
  expect(new Set(ids).size).toBe(50);
});
