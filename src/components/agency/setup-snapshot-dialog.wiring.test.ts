// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wiring of the dialog to storage: the dismissal lives at
 * users/{uid}/settings/setupSnapshot (firestore.rules only lets the owner
 * write displayName/photoURL/updatedAt on users/{uid} itself), non-owners
 * never even fetch, and a dismissed owner never gets the dialog.
 */

const auth = vi.hoisted(() => ({
  value: { user: { uid: "u1" }, loading: false, agencyRole: "owner" } as unknown,
}));
const nav = vi.hoisted(() => ({ path: "/agency" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.path }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth.value }));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: () => "db" }));
const fs = vi.hoisted(() => ({
  dismissed: false,
  paths: [] as string[],
  setDoc: vi.fn(),
}));
vi.mock("firebase/firestore", () => ({
  doc: (_db: unknown, path: string) => {
    fs.paths.push(path);
    return path;
  },
  getDoc: async () => ({ data: () => (fs.dismissed ? { dismissed: true } : undefined) }),
  setDoc: (...a: unknown[]) => fs.setDoc(...a),
  serverTimestamp: () => "TS",
}));

import { SetupSnapshotDialog } from "./setup-snapshot-dialog";

const fetchMock = vi.fn();
let container: HTMLDivElement;
let root: Root;

const mount = async () => {
  await act(async () => {
    root.render(createElement(SetupSnapshotDialog));
  });
  await act(async () => {
    await Promise.resolve();
  });
};

beforeEach(() => {
  nav.path = "/agency";
  fs.dismissed = false;
  fs.paths = [];
  fs.setDoc.mockReset().mockResolvedValue(undefined);
  fetchMock.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, requiredComplete: true, featuresConfigured: 0, featuresTotal: 0, groups: [] }),
  });
  vi.stubGlobal("fetch", fetchMock);
  sessionStorage.clear();
  auth.value = { user: { uid: "u1" }, loading: false, agencyRole: "owner" };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("SetupSnapshotDialog wiring", () => {
  it("reads the dismissal from users/{uid}/settings/setupSnapshot, never the user doc", async () => {
    await mount();
    expect(fs.paths).toEqual(["users/u1/settings/setupSnapshot"]);
    expect(fetchMock).toHaveBeenCalledWith("/api/agency/setup/summary");
  });

  it("does nothing for a non-owner", async () => {
    auth.value = { user: { uid: "u1" }, loading: false, agencyRole: "staff" };
    await mount();
    expect(fs.paths).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing once the owner dismissed it", async () => {
    fs.dismissed = true;
    await mount();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when already shown this session", async () => {
    sessionStorage.setItem("setup-snapshot-shown", "1");
    await mount();
    expect(fs.paths).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes Don't show again to the settings doc, not users/{uid}", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("PointerEvent", MouseEvent);
    try {
      await mount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      const box = document.body.querySelector('[aria-label="Don\'t show this again"]') as HTMLElement;
      expect(box).not.toBeNull();
      await act(async () => {
        box.click();
      });
      const close = [...document.body.querySelectorAll("a,button")].find((e) =>
        e.textContent?.includes("Get started"),
      ) as HTMLElement;
      await act(async () => {
        close.click();
      });
      expect(fs.setDoc).toHaveBeenCalledTimes(1);
      expect(fs.setDoc.mock.calls[0][0]).toBe("users/u1/settings/setupSnapshot");
      expect(fs.setDoc.mock.calls[0][1]).toMatchObject({ dismissed: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not open on /agency/setup itself", async () => {
    nav.path = "/agency/setup";
    vi.useFakeTimers();
    try {
      await mount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
      expect(sessionStorage.getItem("setup-snapshot-shown")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
