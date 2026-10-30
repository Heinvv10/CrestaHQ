import "server-only";

import { z } from "zod";
import { publicFetch } from "@/lib/webhooks/public-fetch";

/**
 * ApexGEO v1 scans API (ApexGEO `docs/api/scans-endpoint-plan.md`), called
 * with the sub-account's own key. The base URL is tenant-supplied, so every
 * call goes through `publicFetch` (public addresses only, no redirects).
 *
 * Never throws: every outcome is a typed result. A response whose shape does
 * not match the schemas below is `bad_response` — the caller marks the
 * section failed rather than filling it from a partial payload.
 */

export const APEXGEO_DEFAULT_BASE_URL = "https://apexgeo.app";
const CALL_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface ApexgeoConnection {
  apiKey: string;
  baseUrl: string;
}

export type ApexgeoErrorKind =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "insufficient_credits"
  | "conflict"
  | "invalid_request"
  | "rate_limited"
  | "server"
  | "bad_response"
  | "network";

/** `message` is for the log only — it may carry the provider's own text. */
export interface ApexgeoError {
  kind: ApexgeoErrorKind;
  status: number | null;
  message: string;
}

type Result<T> = ({ ok: true } & T) | { ok: false; error: ApexgeoError };

const cwv = z.object({
  lcp_ms: z.number(),
  fcp_ms: z.number(),
  tbt_ms: z.number(),
  cls: z.number(),
  speed_index_ms: z.number(),
});

const technical = z.object({
  overall_score: z.number(),
  core_web_vitals: cwv.nullable(),
  core_web_vitals_error: z.string().nullable(),
  https: z.boolean(),
  mobile_viewport: z.boolean().nullable(),
});

const robotsValue = z.enum(["allowed", "blocked"]).nullable();
const aiReadiness = z.object({
  robots: z.object({
    GPTBot: robotsValue,
    ClaudeBot: robotsValue,
    PerplexityBot: robotsValue,
    "Google-Extended": robotsValue,
    Bingbot: robotsValue,
  }),
  robots_txt: z.enum(["found", "missing"]).nullable(),
  robots_error: z.string().nullable(),
  schema_types_found: z.array(z.string()),
  local_business_schema: z.boolean(),
});

const engineResult = z.object({
  key: z.string(),
  model: z.string(),
  mentioned: z.boolean(),
  position: z.number().nullable(),
  competitors_named: z.array(z.string()),
  cited_url: z.string().nullable(),
  error: z.string().nullable(),
});

const aiVisibility = z.object({
  prompts: z.array(z.object({ text: z.string(), engines: z.array(engineResult) })),
});

const scanPayload = z.object({
  id: z.string(),
  status: z.enum(["queued", "running", "completed", "failed"]),
  credits_charged: z.number().nullable(),
  technical: technical.nullable(),
  ai_readiness: aiReadiness.nullable(),
  ai_visibility: aiVisibility.nullable(),
  error: z.string().nullable(),
});

export type ApexgeoScan = z.infer<typeof scanPayload>;
export type ApexgeoEngineResult = z.infer<typeof engineResult>;

const started = z.object({
  data: z.object({
    id: z.string().min(1),
    status: z.string(),
    credits_reserved: z.number(),
    replayed: z.literal(true).optional(),
  }),
});

const errorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export interface StartScanInput {
  url: string;
  businessName: string;
  niche: string;
  city: string;
  country: string;
  /** Idempotency key: a retry with the same ref replays the first scan, uncharged. */
  externalRef: string;
}

/** Engines probed per scan (decision D4): Perplexity answered `insufficient_quota` on every prompt in ApexGEO's live proof. */
export const PROBE = { engines: ["gemini", "chatgpt"], prompts: 3 } as const;

export async function startScan(
  conn: ApexgeoConnection,
  input: StartScanInput,
  signal?: AbortSignal,
): Promise<Result<{ scanId: string; replayed: boolean; creditsReserved: number }>> {
  const res = await call(conn, "/api/v1/scans", signal, {
    method: "POST",
    body: JSON.stringify({
      url: input.url,
      business_name: input.businessName,
      niche: input.niche,
      city: input.city,
      country: input.country,
      probe: PROBE,
      external_ref: input.externalRef,
    }),
  });
  if (!res.ok) return res;
  if (res.status !== 200 && res.status !== 202) return { ok: false, error: unexpected(res.status) };
  const parsed = started.safeParse(res.body);
  if (!parsed.success) return { ok: false, error: badShape(res.status, parsed.error) };
  const d = parsed.data.data;
  return { ok: true, scanId: d.id, replayed: d.replayed === true, creditsReserved: d.credits_reserved };
}

export async function getScan(
  conn: ApexgeoConnection,
  scanId: string,
  signal?: AbortSignal,
): Promise<Result<{ scan: ApexgeoScan }>> {
  const res = await call(conn, `/api/v1/scans/${encodeURIComponent(scanId)}`, signal, { method: "GET" });
  if (!res.ok) return res;
  if (res.status !== 200) return { ok: false, error: unexpected(res.status) };
  const parsed = z.object({ data: scanPayload }).safeParse(res.body);
  if (!parsed.success) return { ok: false, error: badShape(res.status, parsed.error) };
  return { ok: true, scan: parsed.data.data };
}

/**
 * Proves the key and its `read` scope without spending credits: lists at
 * most one scan. (`write`, needed to start scans, cannot be probed for free.)
 */
export async function probeKey(conn: ApexgeoConnection, signal?: AbortSignal): Promise<Result<object>> {
  const res = await call(conn, "/api/v1/scans?limit=1", signal, { method: "GET" });
  if (!res.ok) return res;
  if (res.status !== 200) return { ok: false, error: unexpected(res.status) };
  const parsed = z.object({ data: z.array(z.unknown()) }).safeParse(res.body);
  if (!parsed.success) return { ok: false, error: badShape(res.status, parsed.error) };
  return { ok: true };
}

const ERROR_KIND: Record<string, ApexgeoErrorKind> = {
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  not_found: "not_found",
  insufficient_credits: "insufficient_credits",
  conflict: "conflict",
  invalid_request: "invalid_request",
  rate_limited: "rate_limited",
};

async function call(
  conn: ApexgeoConnection,
  path: string,
  signal: AbortSignal | undefined,
  init: { method: string; body?: string },
): Promise<{ ok: true; status: number; body: unknown } | { ok: false; error: ApexgeoError }> {
  const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
  let res: Response;
  let text: string;
  try {
    res = await publicFetch(`${conn.baseUrl.replace(/\/+$/, "")}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${conn.apiKey}`,
        Accept: "application/json",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      maxBytes: MAX_RESPONSE_BYTES,
    });
    text = await res.text();
  } catch (err) {
    return { ok: false, error: { kind: "network", status: null, message: errorText(err) } };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: { kind: "bad_response", status: res.status, message: "Response is not JSON." } };
  }
  if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, body };
  const envelope = errorBody.safeParse(body);
  const kind = envelope.success ? ERROR_KIND[envelope.data.error.code] : undefined;
  return {
    ok: false,
    error: {
      kind: kind ?? (res.status >= 500 ? "server" : "bad_response"),
      status: res.status,
      message: envelope.success ? envelope.data.error.message : `HTTP ${res.status}`,
    },
  };
}

const unexpected = (status: number): ApexgeoError => ({
  kind: "bad_response",
  status,
  message: `Unexpected HTTP ${status}.`,
});

const badShape = (status: number, err: z.ZodError): ApexgeoError => ({
  kind: "bad_response",
  status,
  message: `Unexpected response shape: ${err.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ")}`,
});

const errorText = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));
