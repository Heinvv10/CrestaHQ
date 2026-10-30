import type { FormResult, FormTrace } from "./engine";
import type { FieldRole, FormIdentity } from "./mapping";

/**
 * The wire between the CRM and the form engine's container (PR 5c). Pure:
 * imported by both sides.
 *
 * stdin, line 1: the job (`RunnerJob` as JSON). The container then writes
 * JSON lines to stdout: `{"type":"submitting"}` right before it would click
 * submit — it then waits for a `go` line on stdin, so the CRM stamps the
 * submit FIRST — and one `{"type":"result","result":…}` at the end.
 *
 * Everything the container writes is UNTRUSTED (a compromised renderer could
 * write anything): `checkResult` validates every field, and anything it
 * can't vouch for is an uncertain send — never `sent`, never refunded.
 */

export interface RunnerJob {
  url: string;
  identity: FormIdentity;
  /** For the logs only. */
  traceId: string;
  limits?: { totalMs?: number; settleMs?: number; confirmMs?: number };
  /** Test-only (the docker-gated integration test); the CRM never sends it. */
  allowPorts?: string[];
}

export const SUBMITTING = "submitting";
export const GO = "go";

const SIGNALS = new Set(["navigation", "thank_you", "post_2xx"]);
const ROLES: ReadonlySet<string> = new Set<FieldRole>(["name", "first", "last", "email", "phone", "company", "subject", "message", "service", "town"]);
const CODE = /^[a-z_]{1,40}$/;
const EMPTY_TRACE: FormTrace = { finalUrl: null, signal: null, mappedFields: [] };

/** Where the page ended, as the trace may keep it: http(s), no query or fragment, ≤ 2,048 chars. */
function safeUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 2048) return null;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? `${u.origin}${u.pathname}` : null;
  } catch {
    return null;
  }
}

function checkTrace(v: unknown): FormTrace | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const t = v as Record<string, unknown>;
  const fields = Array.isArray(t.mappedFields) ? t.mappedFields : null;
  if (!fields || fields.length > 12 || !fields.every((f) => typeof f === "string" && ROLES.has(f))) return null;
  if (t.signal !== null && !(typeof t.signal === "string" && SIGNALS.has(t.signal))) return null;
  return { finalUrl: safeUrl(t.finalUrl), signal: (t.signal as FormTrace["signal"]) ?? null, mappedFields: fields as FieldRole[] };
}

export const maybeSent = (reason: string, trace: FormTrace = EMPTY_TRACE): FormResult => ({
  kind: "uncertain",
  code: "no_signal",
  reason: `The form engine's answer could not be trusted (${reason}); the enquiry may have gone through.`,
  trace,
});

/**
 * The container's result, validated. `submitted`: it announced the submit
 * (and we let it go on). A result that contradicts that — "sent" without a
 * submit, "refused"/"failed" after one — is not believed either.
 */
export function checkResult(raw: unknown, submitted: boolean): FormResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return maybeSent("no result");
  const r = raw as Record<string, unknown>;
  const trace = checkTrace(r.trace);
  if (!trace) return maybeSent("malformed result");
  const reason = typeof r.reason === "string" ? r.reason.slice(0, 500) : "";
  if (r.kind === "sent") return submitted ? { kind: "sent", trace } : maybeSent("sent without a submit", trace);
  if (typeof r.code !== "string" || !CODE.test(r.code)) return maybeSent("malformed code", trace);
  if (r.kind === "refused" || r.kind === "failed") {
    // Not attempted: only believable while no submit was announced.
    if (submitted) return maybeSent(`${r.kind} after the submit`, trace);
    return { kind: r.kind, code: r.code, reason, trace } as FormResult;
  }
  if (r.kind === "rejected") {
    return submitted && r.code === "form_rejected" ? { kind: "rejected", code: "form_rejected", reason, trace } : maybeSent("rejected without a submit", trace);
  }
  // "uncertain" — and any kind it doesn't know, which can only be a maybe.
  const code = r.code === "timeout" || r.code === "captcha_after_submit" ? r.code : "no_signal";
  return { kind: "uncertain", code, reason, trace };
}
