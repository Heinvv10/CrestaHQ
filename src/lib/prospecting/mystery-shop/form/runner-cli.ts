/**
 * The form engine's container entry point (docker/form-engine). No
 * Firestore, no secrets, no volumes: the job comes in on stdin, the answer
 * goes out on stdout (protocol.ts), and the container is thrown away.
 *
 * The SSRF guard is forced on here, whatever the image's environment says:
 * publicFetch only refuses private addresses in "production".
 */
import { createInterface } from "node:readline";
import { ssrfGuardEnabled } from "@/lib/webhooks/validate-url";
import { publicFetch } from "@/lib/webhooks/public-fetch";
import { launchFormBrowser } from "./browser";
import { runFormFill } from "./engine";
import { GO, SUBMITTING, type RunnerJob } from "./protocol";
import { isolationCheck } from "./canary";
import type { FetchImpl } from "./network";

(process.env as Record<string, string>).NODE_ENV = "production";

const ACK_MS = 15_000;
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const write = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const fail = (reason: string) => write({ type: "result", result: { kind: "failed", code: "engine_failed", reason, trace: { finalUrl: null, signal: null, mappedFields: [] } } });

/** The CRM's `go`, within ACK_MS: it has stamped the submit. Anything else stops before the click. */
async function ack(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("no go from the CRM")), ACK_MS);
  });
  const next = await Promise.race([lines.next(), late]).finally(() => clearTimeout(timer));
  if (next.done || next.value.trim() !== GO) throw new Error("no go from the CRM");
}

/**
 * Test-only (the docker-gated integration test sets it with `-e`; the CRM's
 * `docker run` passes no environment): one origin fetched unguarded, so a
 * local fixture can stand in for a prospect's site. Everything else, and
 * always in production, goes through the guarded publicFetch.
 */
const testOrigin = process.env.FORM_ENGINE_TEST_ORIGIN ?? null;
const fetchImpl: FetchImpl = (url, init) =>
  testOrigin && new URL(url).origin === testOrigin
    ? fetch(url, {
        method: init.method, headers: init.headers, signal: init.signal, redirect: "manual",
        body: typeof init.body === "string" || init.body === undefined ? init.body : Buffer.from(init.body),
      })
    : publicFetch(url, init);

async function main() {
  const first = await lines.next();
  let job: RunnerJob;
  try {
    job = JSON.parse(first.done ? "" : first.value) as RunnerJob;
  } catch {
    return fail("The job could not be read.");
  }
  // Fail closed before Chromium starts: if this container can reach the host, the firewall is missing.
  const isolated = await isolationCheck();
  if ((job as { canary?: unknown })?.canary === true) return write({ type: "canary", ok: isolated.ok });
  if (typeof job?.url !== "string" || !job.identity || !ssrfGuardEnabled()) return fail("The job is malformed.");
  if (!isolated.ok) {
    return write({ type: "result", result: { kind: "failed", code: "engine_unisolated", reason: isolated.reason, trace: { finalUrl: null, signal: null, mappedFields: [] } } });
  }
  // Chromium's own sandbox cannot start in this container on velo — measured 2026-10-09: "FATAL:
  // zygote_host_impl_linux.cc:128 No usable sandbox!" (the host restricts unprivileged user namespaces
  // through AppArmor). The locked-down, disposable container is the isolation (RUNBOOK).
  const result = await runFormFill({
    url: job.url,
    identity: job.identity,
    limits: job.limits,
    allowPorts: job.allowPorts,
    fetchImpl,
    launch: () => launchFormBrowser(),
    onBeforeSubmit: async () => {
      write({ type: SUBMITTING });
      await ack();
    },
  });
  write({ type: "result", result });
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    fail(err instanceof Error ? err.message.slice(0, 200) : "The engine crashed.");
    process.exit(1);
  },
);
