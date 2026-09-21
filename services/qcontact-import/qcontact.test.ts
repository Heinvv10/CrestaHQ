import { describe, expect, it, vi } from "vitest";
import { QContactClient } from "./qcontact.ts";

const cfg = { baseUrl: "https://qc.test", email: "u@test", password: "pw" };
const tokenHeaders = (n: number) => ({ uid: "u@test", client: `c${n}`, "access-token": `t${n}` });

describe("QContactClient", () => {
  it("signs in once, then sends the token headers on reads", async () => {
    let signIns = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/sign_in")) {
        signIns++;
        return new Response("{}", { status: 200, headers: tokenHeaders(signIns) });
      }
      const h = init?.headers as Record<string, string>;
      expect(h["access-token"]).toBe("t1");
      return new Response(JSON.stringify({ results: [{ id: 1 }] }), { status: 200 });
    });
    const qc = new QContactClient(cfg, fetchImpl as unknown as typeof fetch);
    expect(await qc.listView("v")).toEqual([{ id: 1 }]);
    await qc.getCase(1);
    expect(signIns).toBe(1);
  });

  it("re-signs-in once on a 401 and replays the read with the new token", async () => {
    let signIns = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/sign_in")) {
        signIns++;
        return new Response("{}", { status: 200, headers: tokenHeaders(signIns) });
      }
      const h = init?.headers as Record<string, string>;
      if (h["access-token"] === "t1") return new Response("", { status: 401 });
      return new Response(JSON.stringify({ id: 7, fields: {} }), { status: 200 });
    });
    const qc = new QContactClient(cfg, fetchImpl as unknown as typeof fetch);
    expect((await qc.getCase(7)).id).toBe(7);
    expect(signIns).toBe(2);
  });

  it("gives up after the second 401 rather than looping", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith("/auth/sign_in")
        ? new Response("{}", { status: 200, headers: tokenHeaders(1) })
        : new Response("", { status: 401 }));
    const qc = new QContactClient(cfg, fetchImpl as unknown as typeof fetch);
    await expect(qc.getCase(1)).rejects.toThrow("HTTP 401");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("fails loudly when sign-in returns no token headers", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const qc = new QContactClient(cfg, fetchImpl as unknown as typeof fetch);
    await expect(qc.signIn()).rejects.toThrow("no token headers");
  });

  it("getLocation reads the c__contactlocation entity by id", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/sign_in")) return new Response("{}", { status: 200, headers: tokenHeaders(1) });
      expect(url).toBe("https://qc.test/api/v2/entities/c__contactlocation/99");
      return new Response(JSON.stringify({ id: 99, label: "Loc", fields: { c__latitude: -26.1, c__longitude: 28.5 } }), { status: 200 });
    });
    const qc = new QContactClient(cfg, fetchImpl as unknown as typeof fetch);
    const loc = await qc.getLocation(99);
    expect(loc.fields).toEqual({ c__latitude: -26.1, c__longitude: 28.5 });
  });

  it("getLocation throws on a non-2xx (e.g. a pin that no longer exists)", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith("/auth/sign_in")
        ? new Response("{}", { status: 200, headers: tokenHeaders(1) })
        : new Response("", { status: 404 }));
    const qc = new QContactClient(cfg, fetchImpl as unknown as typeof fetch);
    await expect(qc.getLocation(99)).rejects.toThrow("HTTP 404");
  });

  it("follows pagination.next until it is null", async () => {
    const pages: Record<string, { ids: number[]; next: number | null }> = {
      "1": { ids: [1, 2], next: 2 }, "2": { ids: [3, 4], next: 3 }, "3": { ids: [5], next: null },
    };
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/sign_in")) return new Response("{}", { status: 200, headers: tokenHeaders(1) });
      const p = pages[new URL(url).searchParams.get("page")!];
      return new Response(JSON.stringify({ results: p.ids.map((id) => ({ id })), pagination: { next: p.next } }), { status: 200 });
    });
    const qc = new QContactClient(cfg, fetchImpl as unknown as typeof fetch);
    expect((await qc.listView("v")).map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
  });
});
