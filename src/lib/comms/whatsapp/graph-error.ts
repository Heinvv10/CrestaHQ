/**
 * Shared handling of Meta Graph API error bodies — used by the template
 * module (cloud-templates.ts) and the settings provider (settings/graph.ts).
 * Dependency-free so either side can import it without a cycle.
 */

/** Meta echoes tokens back in some auth errors, and these messages are shown
 *  to operators and written to logs. */
export function redact(text: string, accessToken: string): string {
  return accessToken ? text.split(accessToken).join("[redacted]") : text;
}

/** Pull Meta's human-readable reason out of a Graph error body. */
export function describeGraphError(raw: string, accessToken: string): string {
  const safe = redact(raw, accessToken);
  try {
    const parsed = JSON.parse(safe) as {
      error?: { message?: string; error_user_msg?: string };
    };
    return (
      parsed.error?.error_user_msg ??
      parsed.error?.message ??
      safe.slice(0, 300)
    );
  } catch {
    return safe.slice(0, 300);
  }
}
