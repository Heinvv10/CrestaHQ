import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dockerArgs, removeArgs, runFormInContainer, type ChildLike } from "./container";
import { dockerEnv } from "./engine-image";
import type { RunnerJob } from "./protocol";

/**
 * The CRM side of the form-engine container, against a fake `docker run`:
 * the exact isolation argv, the submit handshake (stamp first, then `go`),
 * and that nothing the container says is believed unless it validates — a
 * timeout, garbled, oversized or contradictory answer is an uncertain send.
 */

const IMAGE = "leadstack-form-engine:1.62.1-0123456789ab";
const JOB: RunnerJob = {
  url: "https://www.acme.co.za/contact", traceId: "f1",
  identity: { business: "Cresta HQ", email: "info@crestahq.com", phone: null, subject: "s", message: "m", service: "plumber" },
};
const TRACE = { finalUrl: "https://www.acme.co.za/thanks", signal: "navigation", mappedFields: ["name", "message"] };
const REFUSED = { type: "result", result: { kind: "refused", code: "captcha", reason: "x", trace: { ...TRACE, signal: null } } };

class FakeChild extends EventEmitter implements ChildLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: string[] = [];
  received: string[] = [];
  constructor() {
    super();
    this.stdin.on("data", (c: Buffer) => this.received.push(...c.toString("utf8").split("\n").filter(Boolean)));
  }
  kill(signal?: NodeJS.Signals) {
    this.killed.push(signal ?? "SIGTERM");
    setImmediate(() => this.emit("close", null));
    return true;
  }
  say(o: unknown) {
    this.stdout.write(`${typeof o === "string" ? o : JSON.stringify(o)}\n`);
  }
  end(code = 0) {
    setImmediate(() => this.emit("close", code));
  }
}

let child: FakeChild;
let spawned: { cmd: string; args: string[]; env: Record<string, string> }[];
let stamped: number;
const killed: string[] = [];
const stamp = vi.fn(async () => void stamped++);
const deps = (over: Record<string, unknown> = {}) => ({
  spawn: (cmd: string, args: string[], env: Record<string, string>) => (spawned.push({ cmd, args, env }), child),
  remove: async (name: string) => void killed.push(name),
  image: async () => IMAGE,
  ...over,
});
const run = (over: Record<string, unknown> = {}) => runFormInContainer(JOB, stamp, deps(over));
const tick = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  child = new FakeChild();
  spawned = [];
  stamped = 0;
  killed.length = 0;
  stamp.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the docker run", () => {
  it("is exactly the locked-down argv: no env, no volumes, no shell", () => {
    expect(dockerArgs("lsms-form-x", IMAGE)).toEqual([
      "run", "--rm", "-i", "--pull", "never", "--name", "lsms-form-x", "--network", "leadstack-form", "--memory", "1g", "--memory-swap", "1g",
      "--pids-limit", "512", "--cpus", "1", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
      "--tmpfs", "/tmp:size=256m", "--tmpfs", "/home/pwuser:size=64m", "--user", "pwuser", IMAGE,
    ]);
  });

  it("spawns docker with it and sends only the job on stdin", async () => {
    const out = run();
    await tick();
    expect(spawned).toHaveLength(1);
    expect(spawned[0].cmd).toBe("docker");
    expect(spawned[0].args.slice(0, -1).join(" ")).toMatch(/^run --rm -i --pull never --name lsms-form-[0-9a-f-]{12} --network leadstack-form/);
    expect(spawned[0].env).toEqual(dockerEnv());
    expect(spawned[0].args.at(-1)).toBe(IMAGE);
    expect(spawned[0].args.some((a) => /^(-e|--env|-v|--volume|--privileged|--network=host)$/.test(a))).toBe(false);
    expect(JSON.parse(child.received[0])).toEqual(JOB);
    child.say({ type: "result", result: { kind: "refused", code: "captcha", reason: "x", trace: { ...TRACE, signal: null } } });
    child.end();
    await out;
  });
});

describe("stopping it", () => {
  it("is docker rm -f <name>, not docker kill", () => {
    expect(removeArgs("lsms-form-x")).toEqual(["rm", "-f", "lsms-form-x"]);
  });
});

describe("the docker CLI's environment", () => {
  it("is PATH, HOME and DOCKER_HOST only — never the CRM's secrets", () => {
    const env = { PATH: "/usr/bin", HOME: "/home/velo", DOCKER_HOST: "unix:///run/docker.sock", FIREBASE_ADMIN_PRIVATE_KEY: "k", QSTASH_TOKEN: "t", NODE_ENV: "production" };
    expect(dockerEnv(env)).toEqual({ PATH: "/usr/bin", HOME: "/home/velo", DOCKER_HOST: "unix:///run/docker.sock" });
    expect(dockerEnv({ PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });
});

describe("the submit handshake", () => {
  it("stamps the submit, then says go; a validated sent is sent", async () => {
    const out = run();
    await tick();
    child.say({ type: "submitting" });
    await tick();
    await tick();
    expect(stamp).toHaveBeenCalledTimes(1);
    expect(child.received.at(-1)).toBe("go");
    child.say({ type: "result", result: { kind: "sent", trace: TRACE } });
    child.end();
    expect(await out).toEqual({ kind: "sent", trace: { ...TRACE, finalUrl: "https://www.acme.co.za/thanks" } });
  });

  it("a stamp that fails: no go, the container is removed, nothing was submitted (notStarted)", async () => {
    stamp.mockRejectedValueOnce(new Error("firestore down"));
    const out = run();
    await tick();
    child.say({ type: "submitting" });
    const r = await out;
    expect(child.received).not.toContain("go");
    expect(killed).toHaveLength(1);
    expect(r).toMatchObject({ kind: "failed", code: "engine_failed" });
  });

  it("a stamp that hangs can't keep the job waiting: the wall clock answers uncertain (the stamp may land)", async () => {
    stamp.mockImplementationOnce(() => new Promise(() => undefined));
    const out = run({ timeoutMs: 100 });
    await tick();
    child.say({ type: "submitting" });
    const r = await out;
    expect(r.kind).toBe("uncertain");
    expect(child.received).not.toContain("go");
    expect(killed).toHaveLength(1);
  });
});

describe("an untrusted answer", () => {
  const answer = async (lines: unknown[], submit = false, code = 0) => {
    const out = run();
    await tick();
    if (submit) {
      child.say({ type: "submitting" });
      await tick();
      await tick();
    }
    for (const l of lines) child.say(l);
    child.end(code);
    return out;
  };

  it("a validated refusal before any submit is believed (not attempted: the slot comes back)", async () => {
    expect(await answer([{ type: "result", result: { kind: "refused", code: "captcha", reason: "x", trace: { ...TRACE, signal: null } } }])).toMatchObject({
      kind: "refused", code: "captcha",
    });
  });

  it.each([
    ["no result at all", [], true],
    ["a garbled line, even beside a valid refusal", ["{not json", REFUSED], true],
    ["an unexpected message type, even beside a valid refusal", [{ type: "hello" }, REFUSED], true],
    ["a result with an unknown kind", [{ type: "result", result: { kind: "won", code: "x", reason: "x", trace: TRACE } }], true],
    ["a result with an unknown field role", [{ type: "result", result: { kind: "sent", trace: { ...TRACE, mappedFields: ["password"] } } }], true],
    ["a result with no trace", [{ type: "result", result: { kind: "sent" } }], true],
    ["a refusal AFTER the submit", [{ type: "result", result: { kind: "refused", code: "captcha", reason: "x", trace: TRACE } }], true],
    ["a code that is not a code", [{ type: "result", result: { kind: "failed", code: "DROP TABLE", reason: "x", trace: TRACE } }], true],
  ])("%s is uncertain, never sent, never refunded", async (_name, lines, submit) => {
    const r = await answer(lines as unknown[], submit as boolean);
    expect(r.kind).toBe("uncertain");
  });

  it.each([
    ["no answer and exit 137", [], 137],
    ["a garbled line", ["{not json"], 0],
    ["an unexpected message", [{ type: "hello" }], 0],
    ["a claim of sent", [{ type: "result", result: { kind: "sent", trace: TRACE } }], 0],
    ["a claim of uncertain", [{ type: "result", result: { kind: "uncertain", code: "no_signal", reason: "x", trace: TRACE } }], 0],
  ])("before any go, %s is notStarted: nothing can have been clicked", async (_name, lines, code) => {
    expect(await answer(lines as unknown[], false, code as number)).toMatchObject({ kind: "failed", code: "engine_failed" });
  });

  it("the trace keeps no query, fragment or non-http URL from the container", async () => {
    const r = await answer([{ type: "result", result: { kind: "sent", trace: { ...TRACE, finalUrl: "https://x.co.za/t?email=a#b" } } }], true);
    expect(r.trace.finalUrl).toBe("https://x.co.za/t");
    const j = await answer([{ type: "result", result: { kind: "sent", trace: { ...TRACE, finalUrl: "javascript:alert(1)" } } }], true);
    expect(j.trace.finalUrl).toBeNull();
  });

  it("more than 256 KB of output after the go: removed, uncertain", async () => {
    const out = run();
    await tick();
    child.say({ type: "submitting" });
    await tick();
    await tick();
    child.stdout.write("x".repeat(300 * 1024));
    const r = await out;
    expect(killed).toHaveLength(1);
    expect(r.kind).toBe("uncertain");
  });

  it("the wall clock before any submit: docker rm -f, notStarted", async () => {
    const r = await run({ timeoutMs: 50 });
    expect(killed).toHaveLength(1);
    expect(child.killed).toContain("SIGKILL");
    expect(r).toMatchObject({ kind: "failed", code: "engine_failed" });
  });

  it("the wall clock after the go: docker rm -f, uncertain — even if the container never closes", async () => {
    child.kill = (signal) => (child.killed.push(signal ?? "SIGTERM"), true);
    const out = run({ timeoutMs: 100 });
    await tick();
    child.say({ type: "submitting" });
    const r = await out;
    expect(killed).toHaveLength(1);
    expect(r).toMatchObject({ kind: "uncertain" });
  });
});

describe("the container never starting", () => {
  it("no image built: failed engine_failed (nothing ran), docker never called", async () => {
    expect(await run({ image: async () => null })).toMatchObject({ kind: "failed", code: "engine_failed" });
    expect(spawned).toEqual([]);
  });

  it("docker missing (spawn error before any output): failed engine_failed", async () => {
    const out = run();
    await tick();
    child.emit("error", Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }));
    expect(await out).toMatchObject({ kind: "failed", code: "engine_failed" });
  });
});
