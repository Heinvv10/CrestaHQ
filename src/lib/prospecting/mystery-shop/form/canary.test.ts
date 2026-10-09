import { describe, expect, it, vi } from "vitest";
import { CANARY_PORTS, defaultGateway, isolationCheck } from "./canary";

/**
 * The container's network canary (fix round F2): before Chromium starts, the
 * runner tries the host behind its default gateway on ports that should never
 * answer from inside it. Any answer = not isolated (the host firewall is not
 * in place): the job is refused, nothing attempted. Fake connects here.
 */

const ROUTE = `Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT
eth0\t00000000\t0158A8AC\t0003\t0\t0\t0\t00000000\t0\t0\t0
eth0\t0058A8AC\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0
`;

describe("defaultGateway", () => {
  it("reads the default route's gateway from /proc/net/route (little-endian hex)", async () => {
    expect(await defaultGateway(async () => ROUTE)).toBe("172.168.88.1");
    expect(await defaultGateway(async () => ROUTE.replace("0158A8AC", "015810AC"))).toBe("172.16.88.1");
  });

  it("no default route (no network): null", async () => {
    expect(await defaultGateway(async () => ROUTE.split("\n").filter((l) => !l.includes("\t00000000\t0158")).join("\n"))).toBeNull();
  });
});

describe("isolationCheck", () => {
  const gateway = async () => "172.16.88.1";

  it("isolated: none of 22, 5432, 6379 on the gateway connects", async () => {
    const connect = vi.fn(async (_host: string, _port: number) => false);
    expect(await isolationCheck({ gateway, connect })).toEqual({ ok: true });
    expect(connect.mock.calls.map(([h, p]) => `${h}:${p}`)).toEqual(CANARY_PORTS.map((p) => `172.16.88.1:${p}`));
  });

  it.each(CANARY_PORTS)("port %i answering fails closed", async (open) => {
    const out = await isolationCheck({ gateway, connect: async (_h, p) => p === open });
    expect(out).toEqual({ ok: false, reason: `The form engine's container can reach this server (172.16.88.1:${open}): the host firewall is not in place.` });
  });

  it("a gateway it cannot read fails closed; no default route at all is isolated", async () => {
    expect(await isolationCheck({ gateway: async () => { throw new Error("no /proc"); }, connect: async () => false })).toMatchObject({ ok: false });
    expect(await isolationCheck({ gateway: async () => null, connect: async () => true })).toEqual({ ok: true });
  });
});
