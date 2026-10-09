/**
 * Evidence that the ENQUIRY went out (fix round 1, V1). Pure.
 *
 * A confirmation signal after the click only counts when a request started
 * after the click carried the enquiry: its URL or body holds our email
 * address or the message's longest line, raw, URL-encoded or JSON-escaped.
 * And a 2xx JSON answer that says the site refused it (Contact Form 7's
 * `"status":"validation_failed" | "spam" | "mail_failed" | "aborted"`,
 * `"success":false`, `"ok":false`) is a rejection, not a submission.
 */

export interface EnquiryMarkers {
  needles: string[];
}

/** Our email address and the message's longest line — the two things only our submission contains. */
export function enquiryMarkers(id: { email: string; message: string }): EnquiryMarkers {
  const line = id.message.split(/\r?\n/).reduce((a, b) => (b.trim().length > a.length ? b.trim() : a), "");
  return { needles: [id.email.toLowerCase(), ...(line.length >= 12 ? [line.toLowerCase()] : [])] };
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    // Not URL-encoded (or malformed): the raw text is checked anyway.
    return s;
  }
};

export function carriesEnquiry(text: string, markers: EnquiryMarkers): boolean {
  if (!text) return false;
  const forms = [text, decode(text), text.replace(/\\"/g, '"').replace(/\\u0027/g, "'")].map((s) => s.toLowerCase());
  return markers.needles.some((n) => forms.some((f) => f.includes(n)));
}

const REJECTED_STATUS = /^(validation_failed|spam|mail_failed|aborted|invalid)$/i;

/** A 2xx body saying the site refused the submission: the reason, else null. Top-level JSON fields only. */
export function rejectionOf(body: string): string | null {
  const t = body.trim();
  if (!t.startsWith("{")) return null;
  let json: unknown;
  try {
    json = JSON.parse(t);
  } catch {
    return null;
  }
  const o = json as Record<string, unknown>;
  if (typeof o.status === "string" && REJECTED_STATUS.test(o.status)) return o.status;
  if (o.success === false) return "success:false";
  if (o.ok === false) return "ok:false";
  return null;
}
