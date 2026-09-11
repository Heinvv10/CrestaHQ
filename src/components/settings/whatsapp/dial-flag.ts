/**
 * Country flag for a display phone number, as GHL's Numbers list shows one.
 * Longest-prefix match over the common dialling codes; anything not listed
 * (or unparseable) gives null and the header simply shows no flag.
 */

const DIAL_TO_ISO: Array<[string, string]> = [
  ["1", "US"], ["7", "RU"], ["76", "KZ"], ["77", "KZ"], ["20", "EG"], ["27", "ZA"], ["31", "NL"], ["32", "BE"],
  ["33", "FR"], ["34", "ES"], ["39", "IT"], ["41", "CH"], ["43", "AT"], ["44", "GB"],
  ["45", "DK"], ["46", "SE"], ["47", "NO"], ["48", "PL"], ["49", "DE"], ["52", "MX"],
  ["54", "AR"], ["55", "BR"], ["56", "CL"], ["57", "CO"], ["60", "MY"], ["61", "AU"],
  ["62", "ID"], ["63", "PH"], ["64", "NZ"], ["65", "SG"], ["66", "TH"], ["81", "JP"],
  ["82", "KR"], ["84", "VN"], ["86", "CN"], ["90", "TR"], ["91", "IN"], ["92", "PK"],
  ["94", "LK"], ["212", "MA"], ["230", "MU"], ["233", "GH"], ["234", "NG"], ["254", "KE"],
  ["255", "TZ"], ["256", "UG"], ["258", "MZ"], ["260", "ZM"], ["263", "ZW"], ["264", "NA"],
  ["267", "BW"], ["351", "PT"], ["353", "IE"], ["358", "FI"], ["852", "HK"], ["886", "TW"],
  ["966", "SA"], ["971", "AE"], ["972", "IL"], ["974", "QA"],
];

/** "ZA" → 🇿🇦 via regional-indicator letters. */
function isoToFlag(iso: string): string {
  return [...iso.toUpperCase()]
    .map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65))
    .join("");
}

export function flagForDisplayNumber(display: string | null): string | null {
  if (!display) return null;
  const digits = display.replace(/\D/g, "");
  if (!digits) return null;
  let best: string | null = null;
  let bestLen = 0;
  for (const [code, iso] of DIAL_TO_ISO) {
    if (code.length > bestLen && digits.startsWith(code)) {
      best = iso;
      bestLen = code.length;
    }
  }
  return best ? isoToFlag(best) : null;
}
