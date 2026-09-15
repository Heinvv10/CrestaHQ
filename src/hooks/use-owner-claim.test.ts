// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * useOwnerClaim must never say "not_owner" before it knows, must surface a
 * failed claim read as "error" (retryable), and must ignore a stale answer
 * from an earlier user or attempt.
 */

const m = vi.hoisted(() => ({
  auth: { user: null as { uid: string } | null, agencyRole: null as string | null },
  pending: [] as Array<{ resolve: (v: "owner" | "not_owner") => void; reject: (e: Error) => void }>,
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => m.auth }));
vi.mock("@/lib/firebase/id-token-claims", () => ({
  readOwnerClaim: () =>
    new Promise<"owner" | "not_owner">((resolve, reject) => m.pending.push({ resolve, reject })),
}));

import { useOwnerClaim } from "./use-owner-claim";

let root: Root;
let value: ReturnType<typeof useOwnerClaim>;
function Harness() {
  value = useOwnerClaim();
  return null;
}
const render = () => act(async () => root.render(createElement(Harness)));
const settleLast = (how: "owner" | "not_owner" | "error") =>
  act(async () => {
    const p = m.pending[m.pending.length - 1];
    if (how === "error") p.reject(new Error("token read failed"));
    else p.resolve(how);
  });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  m.auth = { user: null, agencyRole: null };
  m.pending = [];
  root = createRoot(document.createElement("div"));
});
afterEach(() => act(() => root.unmount()));

describe("useOwnerClaim", () => {
  it("short-circuits to owner from the auth context without reading the token", async () => {
    m.auth = { user: { uid: "u1" }, agencyRole: "owner" };
    await render();
    expect(value.state).toBe("owner");
    expect(m.pending).toHaveLength(0);
  });

  it("stays loading with no user, and until the claim read answers", async () => {
    await render();
    expect(value.state).toBe("loading");
    expect(m.pending).toHaveLength(0);
    m.auth = { user: { uid: "u1" }, agencyRole: null };
    await render();
    expect(value.state).toBe("loading");
    expect(m.pending).toHaveLength(1);
    await settleLast("not_owner");
    expect(value.state).toBe("not_owner");
  });

  it("reports a failed read as error, and retry re-attempts", async () => {
    m.auth = { user: { uid: "u1" }, agencyRole: null };
    await render();
    await settleLast("error");
    expect(value.state).toBe("error");
    await act(async () => value.retry());
    expect(value.state).toBe("loading");
    expect(m.pending).toHaveLength(2);
    await settleLast("owner");
    expect(value.state).toBe("owner");
  });

  it("ignores an answer that arrives for a previous attempt", async () => {
    m.auth = { user: { uid: "u1" }, agencyRole: null };
    await render();
    const first = m.pending[0];
    await act(async () => value.retry());
    // The stale read settles after the retry — it must not become the answer,
    // even once the current read has answered differently.
    await settleLast("owner");
    expect(value.state).toBe("owner");
    await act(async () => first.resolve("not_owner"));
    expect(value.state).toBe("owner");
  });

  it("ignores an answer that arrives for a previous user", async () => {
    m.auth = { user: { uid: "u1" }, agencyRole: null };
    await render();
    await settleLast("not_owner");
    expect(value.state).toBe("not_owner");
    m.auth = { user: { uid: "u2" }, agencyRole: null };
    await render();
    expect(value.state).toBe("loading");
    expect(m.pending).toHaveLength(2);
  });
});
