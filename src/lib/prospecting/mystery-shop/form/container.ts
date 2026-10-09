import "server-only";

import { execFile, spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { FormResult } from "./engine";
import { FORM_NETWORK, dockerEnv, formEngineImage } from "./engine-image";
import { GO, SUBMITTING, checkResult, maybeSent, type RunnerJob } from "./protocol";

/**
 * Runs one form fill in a disposable, locked-down container (the decision of
 * 2026-10-09: prospects' JavaScript never runs in the CRM's process or as
 * its user). The container gets the job on stdin and nothing else — no
 * environment, no volumes, no secrets — and answers on stdout (protocol.ts).
 *
 * Its answer is untrusted: validated field by field (checkResult) and capped
 * at MAX_STDOUT. Before the CRM's `go` nothing can have been clicked, so any
 * failure then is notStarted (slot back); after it, anything missing,
 * garbled or late is an uncertain send. It runs on its own network
 * (FORM_NETWORK), is never pulled, gets a minimal environment for the docker
 * CLI, and is removed (`docker rm -f`) at CONTAINER_MS whatever it is doing.
 */

export const CONTAINER_MS = 60_000;
const MAX_STDOUT = 256 * 1024;
const NOT_STARTED = "The form engine could not start; nothing was submitted.";

/** Every isolation flag. The CRM passes no `-e` / `--env`, no `-v`, no `--privileged`, no host network, never pulls. */
export function dockerArgs(name: string, image: string): string[] {
  return [
    "run", "--rm", "-i", "--pull", "never", "--name", name,
    "--network", FORM_NETWORK,
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
  spawn?: (cmd: string, args: string[], env: Record<string, string>) => ChildLike;
  /** Removes the container (`docker rm -f <name>`). */
  remove?: (name: string) => Promise<void>;
  image?: () => Promise<string | null>;
  timeoutMs?: number;
}

/** Removing — not just killing — so a stuck container never lingers (`--rm` only acts on a clean exit). */
export const removeArgs = (name: string) => ["rm", "-f", name];

const dockerRemove = (name: string) =>
  new Promise<void>((resolve) => {
    execFile("docker", removeArgs(name), { timeout: 15_000, env: dockerEnv() as NodeJS.ProcessEnv }, (err) => {
      // Already gone (it finished, and --rm removed it) is the usual case.
      if (err && !/No such container/i.test(err.message)) console.error("[mystery-shop/form] docker rm -f failed", name, err.message);
      resolve();
    });
  });

const notStarted = (): FormResult => ({
  kind: "failed", code: "engine_failed", reason: NOT_STARTED, trace: { finalUrl: null, signal: null, mappedFields: [] },
});

/**
 * Until the CRM said `go`, nothing can have been submitted (the runner waits
 * for it before the click): every failure then is `notStarted`, slot back,
 * unless the container's validated answer says refused / failed itself.
 * After `go` — or while the stamp that precedes it is in flight — only a
 * validated answer is believed; anything else is an uncertain send.
 */
export async function runFormInContainer(
  job: RunnerJob,
  onBeforeSubmit: () => Promise<void>,
  deps: ContainerDeps = {},
): Promise<FormResult> {
  const image = await (deps.image ?? formEngineImage)();
  if (!image) return notStarted();
  const name = `lsms-form-${randomUUID().slice(0, 12)}`;
  const remove = deps.remove ?? dockerRemove;
  const spawn = deps.spawn ?? ((cmd: string, args: string[], env: Record<string, string>) => nodeSpawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: env as NodeJS.ProcessEnv }));

  return new Promise<FormResult>((resolve) => {
    let settled = false;
    let stamping = false;
    let submitted = false;
    let result: unknown;
    let broken: string | null = null;
    let bytes = 0;
    let buffer = "";
    let stderr = "";
    const verdict = (why: string) => (submitted || stamping ? maybeSent(why) : notStarted());
    const finish = (r: FormResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const stop = (why: string) => {
      broken ??= why;
      void remove(name);
      child?.kill("SIGKILL");
    };
    // The wall clock answers on its own: a hung stamp or a silent container can never keep the job waiting.
    const timer = setTimeout(() => {
      const r = verdict("it ran out of time");
      stop("it ran out of time");
      finish(r);
    }, deps.timeoutMs ?? CONTAINER_MS);

    let child: ChildLike | undefined;
    try {
      child = spawn("docker", dockerArgs(name, image), dockerEnv());
    } catch (err) {
      console.error("[mystery-shop/form] docker could not be run", err);
      return finish(notStarted());
    }
    const proc = child;
    proc.on("error", (err) => {
      console.error("[mystery-shop/form] docker could not be run", err);
      finish(verdict("docker failed"));
    });
    proc.stdin.on("error", (err) => console.error("[mystery-shop/form] container stdin closed", name, err.message));
    proc.stderr.on("data", (c: Buffer) => {
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
      if (msg?.type === SUBMITTING && !submitted && !stamping && result === undefined) {
        stamping = true;
        try {
          // The stamp lands BEFORE the container may click: after it, anything is an uncertain send.
          await onBeforeSubmit();
        } catch (err) {
          console.error("[mystery-shop/form] submit stamp failed; stopping the container", name, err);
          stamping = false;
          stop("the submit could not be recorded");
          return finish(notStarted());
        }
        stamping = false;
        if (settled) return;
        submitted = true;
        proc.stdin.write(`${GO}\n`);
      } else if (msg?.type === "result" && result === undefined) {
        result = msg.result;
      } else {
        broken ??= "an unexpected message";
      }
    };
    let chain = Promise.resolve();
    proc.stdout.on("data", (c: Buffer) => {
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
    proc.on("close", (code) => {
      void chain.then(() => {
        const checked = broken === null && result !== undefined ? checkResult(result, submitted) : null;
        if (!submitted) {
          // No go was sent: nothing was clicked. Its own validated refusal keeps its code; anything else is notStarted.
          return finish(checked && (checked.kind === "refused" || checked.kind === "failed") ? checked : notStarted());
        }
        if (!checked) {
          console.error("[mystery-shop/form] container answer not trusted", name, { code, broken, stderr: stderr.slice(-500) });
          return finish(maybeSent(broken ?? `no result (exit ${code})`));
        }
        finish(checked);
      });
    });
    proc.stdin.write(`${JSON.stringify(job)}\n`);
  });
}
