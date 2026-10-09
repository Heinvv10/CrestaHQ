import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { CANARY_PORTS, DOCKER_BRIDGE_GATEWAY, defaultGateway, isolationCheck, tcpProbe, type Probe } from "./canary";

/**
 * The container's network canary: with the host firewall in place, every
 * probe to the host is DROPped and times out. Anything else — a connection,
 * a refusal (the host answered: no firewall), an error it doesn't know —
 * means isolation can't be shown, and the job fails closed. Fake connects.
 */

const ROUTE = `Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT
eth0\t00000000\t015810AC\t0003\t0\t0\t0\t00000000\t0\t0\t0
eth0\t005810AC\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0
`;

describe("defaultGateway", () => {
  it("reads the default route's gateway from /proc/net/route (little-endian hex)", async () => {
    expect(await defaultGateway(async () => ROUTE)).toBe("172.16.88.1");
    expect(await defaultGateway(async () => ROUTE.replace("015810AC", "0158A8AC"))).toBe("172.168.88.1");
  });

  it("no default route: null", async () => {
    expect(await defaultGateway(async () => ROUTE.split("\n").filter((l) => !l.includes("\t00000000\t0158")).join("\n"))).toBeNull();
  });
});

describe("isolationCheck", () => {
  const gateway = async () => "172.16.88.1";
  const all = (p: Probe) => async () => p;

  it("isolated only when every probe times out — the gateway and the default docker bridge, on 22, 5432, 6379", async () => {
    const connect = vi.fn(async (_host: string, _port: number): Promise<Probe> => "timeout");
    expect(await isolationCheck({ gateway, connect })).toEqual({ ok: true });
    expect(connect.mock.calls.map(([h, p]) => `${h}:${p}`)).toEqual(
      ["172.16.88.1", DOCKER_BRIDGE_GATEWAY].flatMap((h) => CANARY_PORTS.map((p) => `${h}:${p}`)),
    );
  });

  it("an unreachable host or network (no route) counts as isolated too", async () => {
    expect(await isolationCheck({ gateway, connect: all("unreachable") })).toEqual({ ok: true });
  });

  it.each([
    ["connected", "can reach"],
    ["refused", "can reach"],
    ["error", "could not verify"],
  ] as const)("a probe that %s fails closed", async (probe, wording) => {
    const out = await isolationCheck({ gateway, connect: all(probe) });
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining(wording) });
  });

  it("one answer among timeouts is enough to fail closed — the docker bridge too", async () => {
    const out = await isolationCheck({ gateway, connect: async (h, p) => (h === DOCKER_BRIDGE_GATEWAY && p === 6379 ? "refused" : "timeout") });
    expect(out).toEqual({ ok: false, reason: `The form engine's container can reach this server (${DOCKER_BRIDGE_GATEWAY}:6379): the host firewall is not in place.` });
  });

  it("no default gateway, or one it cannot read, fails closed", async () => {
    expect(await isolationCheck({ gateway: async () => null, connect: all("timeout") })).toMatchObject({ ok: false, reason: expect.stringContaining("could not verify") });
    expect(await isolationCheck({ gateway: async () => { throw new Error("no /proc"); }, connect: all("timeout") })).toMatchObject({ ok: false });
  });
});

describe("tcpProbe (a real socket on loopback)", () => {
  it("a listening port is connected; a closed one is refused — the host answered, so NOT isolated", async () => {
    const server = createServer((sock) => sock.end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    expect(await tcpProbe("127.0.0.1", port)).toBe("connected");
    await new Promise<void>((r) => server.close(() => r()));
    expect(await tcpProbe("127.0.0.1", port)).toBe("refused");
  });
});
