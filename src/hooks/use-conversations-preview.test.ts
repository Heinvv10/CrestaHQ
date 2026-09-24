// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConversationDoc } from "@/types/conversations";

const fetchNewestConversations = vi.fn();
vi.mock("@/lib/firestore/conversations", () => ({
  fetchNewestConversations: (...a: unknown[]) => fetchNewestConversations(...a),
}));

import { useConversationsPreview } from "./use-conversations-preview";

/**
 * The inbox preview is a first paint only: it must never outlive the full
 * list or leak across sub-accounts, and a failed fetch must cost nothing but the
 * early paint.
 */
const SCOPE = "sa1";
const LIST = [{ id: "c1" }, { id: "c2" }] as ConversationDoc[];

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let latest: ConversationDoc[] | null = null;
let root: ReturnType<typeof createRoot> | null = null;

// One component type for the whole test, so re-renders update the same
// mounted instance (a fresh type per render would remount and hide races).
function Probe({ scope, enabled }: { scope: string | null; enabled: boolean }) {
  latest = useConversationsPreview(scope, 100, enabled);
  return null;
}

async function render(scope: string | null, enabled: boolean) {
  await act(async () => root!.render(createElement(Probe, { scope, enabled })));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fetchNewestConversations.mockReset();
  latest = null;
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root!.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("fetches the newest page for the scope while enabled", async () => {
  fetchNewestConversations.mockResolvedValue(LIST);
  await render(SCOPE, true);
  expect(fetchNewestConversations).toHaveBeenCalledWith(SCOPE, 100);
  expect(latest).toEqual(LIST);
});

it("does not fetch while disabled", async () => {
  await render(SCOPE, false);
  expect(fetchNewestConversations).not.toHaveBeenCalled();
  expect(latest).toBeNull();
});

it("clears a landed preview once disabled", async () => {
  fetchNewestConversations.mockResolvedValue(LIST);
  await render(SCOPE, true);
  expect(latest).toEqual(LIST);
  await render(SCOPE, false);
  expect(latest).toBeNull();
});

it("clears once disabled, and drops a result that lands afterwards", async () => {
  const d = deferred<ConversationDoc[]>();
  fetchNewestConversations.mockReturnValue(d.promise);
  await render(SCOPE, true);
  await render(SCOPE, false); // the full list won the race
  await act(async () => d.resolve(LIST));
  expect(latest).toBeNull();
});

it("drops a result for a sub-account the user has left", async () => {
  const first = deferred<ConversationDoc[]>();
  fetchNewestConversations.mockReturnValueOnce(first.promise);
  fetchNewestConversations.mockReturnValueOnce(new Promise(() => undefined));
  await render(SCOPE, true);
  await render("sa2", true);
  await act(async () => first.resolve(LIST));
  expect(latest).toBeNull();
});

it("a failed fetch leaves no preview and says so", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  fetchNewestConversations.mockRejectedValue(new Error("FAILED_PRECONDITION"));
  await render(SCOPE, true);
  expect(latest).toBeNull();
  expect(warn).toHaveBeenCalledWith(
    "[conversations] newest-page preview failed",
    expect.any(Error),
  );
});
