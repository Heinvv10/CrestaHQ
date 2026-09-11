/** A parseable https URL — the only kind of Google review link the config routes accept. */
export function isHttpsUrl(s: string): boolean {
  try {
    return new URL(s).protocol === "https:";
  } catch {
    return false;
  }
}
