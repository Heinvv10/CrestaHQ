import "server-only";

import { execFile, spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { FormResult } from "./engine";
import { formEngineImage } from "./engine-image";
import { GO, SUBMITTING, checkResult, maybeSent, type RunnerJob } from "./protocol";

/**
 * Runs one form fill in a disposable, locked-down container (the decision of
 * 2026-10-09: prospects' JavaScript never runs in the CRM's process or as
 * its user). The container gets the job on stdin and nothing else — no
 * environment, no volumes, no secrets — and answers on stdout (protocol.ts).
 *
 * Its answer is untrusted: validated field by field (checkResult), capped at
 * MAX_STDOUT, and anything missing, garbled or late is an uncertain send.
 * The only "nothing happened" outcomes it can produce are a validated
 * refused / failed result given before any submit was announced, and the
 * container never starting at all (no image, no docker). It is killed
 * (`docker kill`) at CONTAINER_MS whatever it is doing.
 */

export const CONTAINER_MS = 60_000;
const MAX_STDOUT = 256 * 1024;
const NOT_STARTED = "The form engine could not start; nothing was submitted.";

/** Every isolation flag. The CRM passes no `-e` / `--env`, no `-v`, no `--privileged`, no host network. */
export function dockerArgs(name: string, image: string): string[] {
  return [
    "run", "--rm", "-i", "--name", name,
    "--network", "bridge",
    "--memory", "1g", "--memory-swap", "1g",
    "--pids-limit", "512",
    "--cpus", "1",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--tmpfs", "/tmp:size=256m",
    "--tmpfs", "/home/pwuser:size=64m",
    "--user", "pwuser",
    image,
  ];
}

export interface ChildLike {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill: (signal?: NodeJS.Signals) => boolean;
  on(event: "close", cb: (code: number | null) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
}

export interface ContainerDeps {
  spawn?: (cmd: string, args: string[]) => ChildLike;
  /** `docker kill <name>`. */
  kill?: (name: string) => Promise<void>;
  image?: () => Promise<string | null>;
  timeoutMs?: number;
}

const dockerKill = (name: string) =>
  new Promise<void>((resolve) => {
    execFile("docker", ["kill", name], { timeout: 15_000 }, (err) => {
      // Already gone (it finished, or --rm removed it) is the usual case.
      if (err && !/No such container/i.test(err.message)) console.error("[mystery-shop/form] docker kill failed", name, err.message);
      resolve();
    });
  });

const notStarted = (): FormResult => ({
  kind: "failed", code: "engine_failed", reason: NOT_STARTED, trace: { finalUrl: null, signal: null, mappedFields: [] },
});

export async function runFormInContainer(
  job: RunnerJob,
  onBeforeSubmit: () => Promise<void>,
  deps: ContainerDeps = {},
): Promise<FormResult> {
  const image = await (deps.image ?? formEngineImage)();
  if (!image) return notStarted();
  const name = `lsms-form-${randomUUID().slice(0, 12)}`;
  const kill = deps.kill ?? dockerKill;
  const spawn = deps.spawn ?? ((cmd: string, args: string[]) => nodeSpawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] }));

  return new Promise<FormResult>((resolve) => {
    let settled = false;
    let submitted = false;
    let result: unknown;
    let broken: string | null = null;
    let bytes = 0;
    let buffer = "";
    let stderr = "";
    const finish = (r: FormResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const stop = (why: string) => {
      broken ??= why;
      void kill(name);
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop("it ran out of time"), deps.timeoutMs ?? CONTAINER_MS);

    let child: ChildLike;
    try {
      child = spawn("docker", dockerArgs(name, image));
    } catch (err) {
      console.error("[mystery-shop/form] docker could not be run", err);
      clearTimeout(timer);
      return resolve(notStarted());
    }
    // docker itself missing: nothing ran.
    child.on("error", (err) => {
      console.error("[mystery-shop/form] docker could not be run", err);
      finish(bytes === 0 ? notStarted() : maybeSent("docker failed"));
    });
    child.stdin.on("error", (err) => console.error("[mystery-shop/form] container stdin closed", name, err.message));
    child.stderr.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString("utf8")).slice(-4_000);
    });

    const onLine = async (line: string) => {
      let msg: { type?: unknown; result?: unknown };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        broken ??= "a garbled line";
        return;
      }
      if (msg?.type === SUBMITTING && !submitted && result === undefined) {
        try {
          // The stamp lands BEFORE the container may click: after it, anything is an uncertain send.
          await onBeforeSubmit();
        } catch (err) {
          console.error("[mystery-shop/form] submit stamp failed; stopping the container", name, err);
          return stop("the submit could not be recorded");
        }
        submitted = true;
        child.stdin.write(`${GO}\n`);
      } else if (msg?.type === "result" && result === undefined) {
        result = msg.result;
      } else {
        broken ??= "an unexpected message";
      }
    };
    let chain = Promise.resolve();
    child.stdout.on("data", (c: Buffer) => {
      bytes += c.length;
      if (bytes > MAX_STDOUT) return stop("too much output");
      buffer += c.toString("utf8");
      let at: number;
      while ((at = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line) chain = chain.then(() => onLine(line));
      }
    });
    child.on("close", (code) => {
      void chain.then(() => {
        if (broken !== null || result === undefined) {
          console.error("[mystery-shop/form] container answer not trusted", name, { code, broken, stderr: stderr.slice(-500) });
          // Before any announced submit and with no answer at all, a failure to start is still a maybe:
          // only the container's own validated word, or docker never running, is "nothing happened".
          return finish(maybeSent(broken ?? `no result (exit ${code})`));
        }
        finish(checkResult(result, submitted));
      });
    });
    child.stdin.write(`${JSON.stringify(job)}\n`);
  });
}
