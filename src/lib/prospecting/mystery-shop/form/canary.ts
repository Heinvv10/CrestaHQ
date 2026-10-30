import { readFile } from "node:fs/promises";
import { connect as netConnect } from "node:net";

/**
 * The form engine's network canary, run inside the container before
 * Chromium starts (runner-cli.ts). With the host firewall
 * (scripts/form-engine-firewall.sh) in place every packet from the container
 * to the host is DROPped, so each probe — the container's default gateway and
 * the default docker bridge's, on ports a host never exposes to it — must
 * TIME OUT (or find no route). A connection, a refusal (the host answered:
 * there is no firewall), no default gateway or any error it doesn't know
 * means isolation cannot be shown: the job is refused, nothing attempted, and
 * the CRM marks the channel unavailable until a later canary passes.
 */

export const CANARY_PORTS = [22, 5432, 6379];
/** The default docker bridge's gateway: the host on docker0. The firewall drops all RFC1918, this too. */
export const DOCKER_BRIDGE_GATEWAY = "172.17.0.1";
const CONNECT_MS = 1_500;

export type Probe = "connected" | "refused" | "timeout" | "unreachable" | "error";

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

/** A socket error, as a probe: refused = the host answered; no route = unreachable; anything else = unknown. */
export function probeOfError(code: string | undefined): Probe {
  if (code === "ECONNREFUSED") return "refused";
  return code === "EHOSTUNREACH" || code === "ENETUNREACH" ? "unreachable" : "error";
}

/** One TCP probe, within CONNECT_MS. */
export function tcpProbe(host: string, port: number): Promise<Probe> {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port, timeout: CONNECT_MS });
    const done = (p: Probe) => {
      socket.destroy();
      resolve(p);
    };
    socket.once("connect", () => done("connected"));
    socket.once("timeout", () => done("timeout"));
    socket.once("error", (err: NodeJS.ErrnoException) => done(probeOfError(err.code)));
  });
}

const notVerified = (why: string) => ({ ok: false as const, reason: `The form engine could not verify its isolation (${why}).` });

export async function isolationCheck(
  deps: { gateway?: () => Promise<string | null>; connect?: (host: string, port: number) => Promise<Probe> } = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let gateway: string | null;
  try {
    gateway = await (deps.gateway ?? (() => defaultGateway()))();
  } catch (err) {
    return notVerified(err instanceof Error ? err.message : "no route table");
  }
  if (gateway === null) return notVerified("no default gateway");
  const connect = deps.connect ?? tcpProbe;
  const targets = [...new Set([gateway, DOCKER_BRIDGE_GATEWAY])].flatMap((host) => CANARY_PORTS.map((port) => ({ host, port })));
  // All at once: a firewalled host times every probe out, so this takes one CONNECT_MS, not six.
  const probes = await Promise.all(targets.map(({ host, port }) => connect(host, port)));
  for (const [i, probe] of probes.entries()) {
    const { host, port } = targets[i];
    if (probe === "timeout" || probe === "unreachable") continue;
    if (probe === "error") return notVerified(`${host}:${port} gave an unexpected error`);
    return { ok: false, reason: `The form engine's container can reach this server (${host}:${port}): the host firewall is not in place.` };
  }
  return { ok: true };
}
