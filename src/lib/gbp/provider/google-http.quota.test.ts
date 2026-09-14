import { afterEach, describe, expect, it, vi } from "vitest";

import { errorForStatus, fetchJson } from "./google-http";

/**
 * SP5 G4 — a 429 that is Google saying "this project has NO quota" (API
 * access not approved yet) is not a rate limit: it becomes
 * `access_not_approved`, which nothing retries. The body below has the shape
 * Google returns (RESOURCE_EXHAUSTED + ErrorInfo metadata.quota_limit_value
 * "0"), with fixture values only.
 */

const PROJECT = "000000000000";
const quotaBody = (limit: string, status = "RESOURCE_EXHAUSTED") => ({
  error: {
    code: 429,
    message: `Quota exceeded for quota metric 'Requests' and limit 'Requests per minute' of service 'businessprofileperformance.googleapis.com' for consumer 'project_number:${PROJECT}'.`,
    status,
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "RATE_LIMIT_EXCEEDED",
        domain: "googleapis.com",
        metadata: {
          quota_limit: "RequestsPerMinutePerProject",
          quota_metric: "businessprofileperformance.googleapis.com/default_requests",
          service: "businessprofileperformance.googleapis.com",
          quota_location: "global",
          consumer: `projects/${PROJECT}`,
          quota_limit_value: limit,
        },
      },
      { "@type": "type.googleapis.com/google.rpc.Help", links: [{ description: "Request a higher quota limit.", url: "https://cloud.google.com/docs/quotas/help/request_increase" }] },
    ],
  },
});
const res429 = (headers: Record<string, string> = {}) => new Response(null, { status: 429, headers });

afterEach(() => vi.unstubAllGlobals());

describe("errorForStatus on a 429", () => {
  it("quota_limit_value 0 + RESOURCE_EXHAUSTED → access_not_approved, with no retry hint", () => {
    const err = errorForStatus(res429({ "retry-after": "30" }), quotaBody("0"));
    expect(err.kind).toBe("access_not_approved");
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBeUndefined();
  });

  it.each([
    ["a real (non-zero) quota", quotaBody("600")],
    ["quota 0 without RESOURCE_EXHAUSTED", quotaBody("0", "UNAVAILABLE")],
    ["an empty body", {}],
    ["a null body (not JSON)", null],
    ["details that are not a list", { error: { status: "RESOURCE_EXHAUSTED", details: "quota_limit_value 0" } }],
    ["a numeric 0 (Google sends a string)", { error: { status: "RESOURCE_EXHAUSTED", details: [{ metadata: { quota_limit_value: 0 } }] } }],
  ])("%s → still rate_limited", (_label, body) => {
    const err = errorForStatus(res429({ "retry-after": "7" }), body);
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterMs).toBe(7000);
  });
});

describe("through fetchJson, the way every provider call meets it", () => {
  it("throws access_not_approved whose message carries nothing from the body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(quotaBody("0")), { status: 429 })));
    const err = (await fetchJson("https://businessprofileperformance.googleapis.com/v1/x", {}).catch((e: unknown) => e)) as Error;
    expect(err).toMatchObject({ kind: "access_not_approved" });
    expect(err.message).toBe("Google Business Profile provider error: access_not_approved (HTTP 429)");
    for (const leak of [PROJECT, "Quota exceeded", "quota_limit", "businessprofileperformance"]) {
      expect(err.message).not.toContain(leak);
    }
  });
});
