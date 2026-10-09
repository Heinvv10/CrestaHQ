import { readFile } from "node:fs/promises";
import { connect as netConnect } from "node:net";

/**
 * The form engine's network canary, run inside the container before
 * Chromium starts (runner-cli.ts): the host behind the container's default
 * gateway must NOT answer on ports a firewalled host never exposes to it. Any
 * answer means the host firewall (scripts/form-engine-firewall.sh) is not in
 * place, so the job is refused — nothing attempted — and the CRM marks the
 * channel unavailable until a later canary passes. Fails closed when it
 * cannot tell.
 */

export const CANARY_PORTS = [22, 5432, 6379];
const CONNECT_MS = 1_500;

/** The default route's gateway from /proc/net/route (little-endian hex), or null with no default route. */
export async function defaultGateway(read: () => Promise<string> = () => readFile("/proc/net/route", "utf8")): Promise<string | null> {
  for (const line of (await read()).split("\n").slice(1)) {
    const [, destination, gateway] = line.trim().split(/\s+/);
    if (destination === "00000000" && gateway && /^[0-9A-F]{8}$/i.test(gateway)) {
      return [3, 2, 1, 0].map((i) => parseInt(gateway.slice(i * 2, i * 2 + 2), 16)).join(".");
    }
  }
  return null;
}

/** Did a TCP connection open within CONNECT_MS? */
export function tcpConnects(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port, timeout: CONNECT_MS });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export async function isolationCheck(
  deps: { gateway?: () => Promise<string | null>; connect?: (host: string, port: number) => Promise<boolean> } = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let gateway: string | null;
  try {
    gateway = await (deps.gateway ?? (() => defaultGateway()))();
  } catch (err) {
    return { ok: false, reason: `The form engine could not check its isolation (${err instanceof Error ? err.message : "no route table"}).` };
  }
  if (gateway === null) return { ok: true };
  const connect = deps.connect ?? tcpConnects;
  for (const port of CANARY_PORTS) {
    if (await connect(gateway, port)) {
      return { ok: false, reason: `The form engine's container can reach this server (${gateway}:${port}): the host firewall is not in place.` };
    }
  }
  return { ok: true };
}
