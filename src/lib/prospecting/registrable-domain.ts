/**
 * The registrable domain of a host name: its last two labels, or three under
 * a two-label public suffix like co.za / com.au (`www.acme.co.za` →
 * `acme.co.za`). Lower-cased, any trailing dot dropped. Pure — imported by
 * sections/lead-capture.ts, which scripts load under plain Node.
 */

const TWO_LABEL_SUFFIX = /^(co|com|org|net|ac|gov|edu|ltd|plc|web)\.[a-z]{2}$/;

export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  const take = labels.length >= 3 && TWO_LABEL_SUFFIX.test(labels.slice(-2).join(".")) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** Same site: both hosts sit under one registrable domain. IP literals only match themselves. */
export function sameSite(a: string, b: string): boolean {
  const ip = (h: string) => h.startsWith("[") || /^[0-9.]+$/.test(h);
  if (ip(a) || ip(b)) return a.toLowerCase() === b.toLowerCase();
  return registrableDomain(a) === registrableDomain(b);
}
