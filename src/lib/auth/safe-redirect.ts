/**
 * Where to land after a successful sign-in.
 *
 * `?redirect` is attacker-supplied — /login is a public path, so anyone can
 * hand a victim `https://crm.crestahq.com/login?redirect=//evil.com`. Only
 * same-origin, root-relative paths are honoured; anything else falls back to
 * the dashboard.
 *
 * `//host` (protocol-relative) and `/\host` (which browsers normalise to the
 * same thing) both leave the origin despite starting with a slash, so they are
 * rejected explicitly rather than by the leading-slash check alone.
 */
export function safeRedirect(value: string | null | undefined): string {
  if (!value) return "/dashboard";
  if (!value.startsWith("/")) return "/dashboard";
  if (value.startsWith("//") || value.startsWith("/\\")) return "/dashboard";
  return value;
}
