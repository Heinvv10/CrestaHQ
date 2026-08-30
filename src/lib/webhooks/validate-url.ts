/**
 * Which automation tool a webhook destination URL belongs to, when it's
 * recognizable. Powers tool-specific advice — most importantly n8n's
 * test-vs-production URL trap: the Test URL (`…/webhook-test/…`) only
 * receives events while the n8n editor is actively listening ("Execute
 * workflow"); the Production URL (`…/webhook/…`, same path otherwise) only
 * responds once the workflow's Active toggle is on. A webhook registered
 * against the Test URL verifies fine in the moment and then silently dies.
 */
export interface AutomationUrlInfo {
  tool: "n8n" | "make" | "zapier" | null;
  /** Only set for n8n-shaped URLs. */
  n8nKind?: "test" | "production";
}

export function detectAutomationUrl(raw: string): AutomationUrlInfo {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { tool: null };
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();

  // `/webhook-test/` is unique to n8n regardless of hostname (self-hosted
  // instances rarely advertise "n8n" in the domain).
  if (path.includes("/webhook-test/")) {
    return { tool: "n8n", n8nKind: "test" };
  }
  if (path.includes("/webhook/") && (host.includes("n8n") || /\/webhook\/[0-9a-f-]{20,}/.test(path))) {
    return { tool: "n8n", n8nKind: "production" };
  }
  if (/^hook\.[a-z0-9-]+\.make\.com$/.test(host)) return { tool: "make" };
  if (host === "hooks.zapier.com") return { tool: "zapier" };
  return { tool: null };
}

/** The n8n Production URL for a given n8n Test URL (same path, different segment). */
export function n8nProductionUrl(testUrl: string): string {
  return testUrl.replace("/webhook-test/", "/webhook/");
}

/**
 * Destination-URL validation for outbound webhook subscriptions — shared by
 * the management API route and the AI Suite's create_webhook capability so
 * both enforce identical rules:
 *   - http/https only (https required in production, except localhost)
 *   - private / loopback hostnames rejected in production (SSRF guard)
 */
export function validateWebhookUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; error: string } {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { ok: false, error: "URL must use http or https." };
    }
    if (
      url.protocol === "http:" &&
      process.env.NODE_ENV === "production" &&
      !url.hostname.endsWith(".localhost") &&
      url.hostname !== "localhost"
    ) {
      return { ok: false, error: "Production URLs must use https." };
    }
    // Block private + loopback hosts in production to prevent SSRF.
    if (process.env.NODE_ENV === "production") {
      const h = url.hostname;
      if (
        h === "localhost" ||
        h === "0.0.0.0" ||
        h.endsWith(".localhost") ||
        /^127\./.test(h) ||
        /^10\./.test(h) ||
        /^192\.168\./.test(h) ||
        /^172\.(1[6-9]|2[0-9]|3[01])\./.test(h) ||
        /^169\.254\./.test(h)
      ) {
        return { ok: false, error: "Private / loopback hostnames are not allowed." };
      }
    }
    return { ok: true, url: url.toString() };
  } catch {
    return { ok: false, error: "Invalid URL." };
  }
}
