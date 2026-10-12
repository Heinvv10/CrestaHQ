// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  CARDS, buttons, fetchMock, flush, h, loaded, mount, picker, remount, render, setupConceptPickerTests, unhandled, until,
} from "@/test/concept-picker-harness";

// Real concepts route, only gitpage stubbed — see src/test/concept-picker-harness.ts.
vi.mock("@/lib/firebase/admin", async () => {
  const { mem, claims } = await import("@/test/concept-picker-harness");
  return {
    getAdminDb: () => mem.db,
    getAdminAuth: () => ({ getUser: async (uid: string) => ({ customClaims: claims[uid] ?? {} }) }),
  };
});
setupConceptPickerTests();

describe("ConceptPicker — loading and picking", () => {
  it("shows a status while loading, and calls the route with the niche", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    h.gitpage = async (url) => { await hold; return Response.json({ concepts: CARDS[url.searchParams.get("niche")!] }); };
    await render(picker());
    expect(h.host.querySelector('[role="status"]')?.textContent).toContain("Loading design directions");
    expect(fetchMock).toHaveBeenCalledWith("/api/sub-accounts/sa1/website/concepts?niche=gym_fitness");
    await act(async () => release());
    await loaded();
    expect(h.host.textContent).toContain("iron pitch");
  });

  it("omits the niche query when there is none", async () => {
    await mount({ niche: null });
    expect(fetchMock).toHaveBeenCalledWith("/api/sub-accounts/sa1/website/concepts");
  });

  it("renders loaded cards with the selected one pressed, and reports picks", async () => {
    const onChange = vi.fn();
    await mount({ value: "pulse", onChange });
    expect(buttons().map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false", "true"]);
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => buttons()[1].click());
    expect(onChange).toHaveBeenLastCalledWith("iron");
    await act(async () => buttons()[0].click());
    expect(onChange).toHaveBeenLastCalledWith(null);
    // Only phrasing content inside a <button>.
    expect(h.host.querySelectorAll("button p, button div")).toHaveLength(0);
  });

  it("paints a swatch only from a hex accent, and survives a card with missing fields", async () => {
    // A 200 body straight from the network (the picker's own guard, not the route's).
    fetchMock.mockImplementationOnce(async () =>
      Response.json({
        concepts: [
          { id: "ok", name: "Ok", accents: { dark: "#00ff00" } },
          // Valid CSS, so only the picker's hex check keeps it off the page.
          { id: "bad", name: "Bad", accents: { dark: "red" }, defaultMode: "dark" },
          { id: "bare", name: "Bare" },
          { id: 7, name: "not a card" },
          null,
        ],
      }),
    );
    await mount();
    const swatches = Array.from(h.host.querySelectorAll<HTMLElement>('[data-testid="concept-swatch"]'));
    expect(swatches).toHaveLength(3);
    expect(swatches[0].style.backgroundColor).toBe("rgb(0, 255, 0)");
    expect(swatches[1].getAttribute("style")).toBeNull();
    expect(swatches[2].getAttribute("style")).toBeNull();
    expect(h.host.textContent).toContain("Bare");
  });
});

describe("ConceptPicker — the saved selection", () => {
  it("clears a saved concept a SUCCESSFUL list does not contain", async () => {
    const onChange = vi.fn();
    await mount({ value: "gone", onChange });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("clears a different niche's concept once the new niche loads successfully", async () => {
    const onChange = vi.fn();
    await mount({ niche: "gym_fitness", value: "iron", onChange });
    expect(onChange).not.toHaveBeenCalled();
    await render(picker({ niche: "home_services", value: "iron", onChange }));
    await loaded();
    expect(h.host.textContent).toContain("tradesman pitch");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("keeps the saved concept when the load FAILS, and says so", async () => {
    h.gitpage = () => Response.json({ error: "Rate limited." }, { status: 429 });
    const onChange = vi.fn();
    await mount({ niche: "home_services", value: "iron", onChange });
    expect(h.host.querySelector('[role="status"]')?.textContent).toBe(
      "The design service is unavailable right now. Your chosen design direction is kept.",
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the saved concept when gitpage answers 200 without a concepts list (a maintenance page)", async () => {
    h.gitpage = () => new Response("<html>Back soon</html>", { status: 200 });
    const onChange = vi.fn();
    await mount({ value: "iron", onChange });
    expect(h.host.querySelector('[role="status"]')?.textContent).toBe(
      "The design service is unavailable right now. Your chosen design direction is kept.",
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a stale response for the old niche, landing LAST, neither overwrites the cards nor clears the pick", async () => {
    const releases = new Map<string, () => void>();
    h.gitpage = async (url) => {
      const niche = url.searchParams.get("niche")!;
      await new Promise<void>((r) => releases.set(niche, r));
      return Response.json({ concepts: CARDS[niche] });
    };
    const onChange = vi.fn();
    await render(picker({ niche: "gym_fitness", value: null, onChange }));
    await until(() => releases.has("gym_fitness"), "the first load to reach gitpage");
    // The operator switches niche and picks before the first load returns.
    await render(picker({ niche: "home_services", value: "tradesman", onChange }));
    await until(() => releases.has("home_services"), "the second load to reach gitpage");
    await act(async () => releases.get("home_services")!());
    await until(() => h.bodiesRead === 1, "the second body");
    await loaded();
    expect(h.host.textContent).toContain("tradesman pitch");
    await act(async () => releases.get("gym_fitness")!());
    await until(() => h.bodiesRead === 2, "the stale body");
    await flush();
    expect(h.host.textContent).toContain("tradesman pitch");
    expect(h.host.textContent).not.toContain("iron pitch");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("judges the loaded list against the value and onChange of NOW, not of when the fetch began", async () => {
    let release: (() => void) | undefined;
    h.gitpage = async (url) => {
      await new Promise<void>((r) => { release = r; });
      return Response.json({ concepts: CARDS[url.searchParams.get("niche")!] });
    };
    const first = vi.fn();
    await render(picker({ value: "gone", onChange: first }));
    await until(() => release !== undefined, "the load to reach gitpage");
    // While loading, the operator picks a concept that IS in the coming list.
    const second = vi.fn();
    await render(picker({ value: "iron", onChange: second }));
    await act(async () => release!());
    await until(() => h.bodiesRead === 1, "the body");
    await loaded();
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it("clears with the CURRENT onChange when the value changed to a missing id mid-load", async () => {
    let release: (() => void) | undefined;
    h.gitpage = async (url) => {
      await new Promise<void>((r) => { release = r; });
      return Response.json({ concepts: CARDS[url.searchParams.get("niche")!] });
    };
    const first = vi.fn();
    await render(picker({ value: "iron", onChange: first }));
    await until(() => release !== undefined, "the load to reach gitpage");
    const second = vi.fn();
    await render(picker({ value: "gone", onChange: second }));
    await act(async () => release!());
    await until(() => h.bodiesRead === 1, "the body");
    await loaded();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(null);
  });

  it("a response landing after unmount does not touch the selection", async () => {
    let release: (() => void) | undefined;
    h.gitpage = async () => {
      await new Promise<void>((r) => { release = r; });
      return Response.json({ concepts: [] });
    };
    const onChange = vi.fn();
    await render(picker({ value: "iron", onChange }));
    await until(() => release !== undefined, "the load to reach gitpage");
    await remount();
    await act(async () => release!());
    await until(() => h.bodiesRead === 1, "the late body");
    await flush();
    expect(onChange).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });
});
