import { sameSite } from "@/lib/prospecting/registrable-domain";

/**
 * Evidence that the ENQUIRY went out (fix round 1, V1). Pure.
 *
 * A confirmation signal after the click only counts when a request started
 * after the click carried the enquiry: its URL or body holds our email
 * address or the message's longest line, raw, URL-encoded or JSON-escaped.
 * And a 2xx JSON answer that says the site refused it (Contact Form 7's
 * `"status":"validation_failed" | "spam" | "mail_failed" | "aborted"`,
 * `"success":false`, `"ok":false`) is a rejection, not a submission.
 *
 * Our email alone is enough to keep a request from leaving before the click,
 * but not to stand for the enquiry after it: a newsletter or email-check call
 * carries the address too, and its 2xx says nothing about the enquiry. What
 * the signals hang on must carry the message (`carriesMessage`).
 */

/** Third-party form backends whose 2xx to a POST counts as a submission. */
const FORM_BACKENDS =
  /(^|\.)(formspree\.io|getform\.io|hsforms\.com|jotform\.com|typeform\.com|formsubmit\.co|web3forms\.com|usebasin\.com|formcarry\.com|wufoo\.com|zohopublic\.com)$/i;

/** The form's own site, or a third-party form backend: where an answer to the enquiry may come from. */
export function knownHost(host: string, formUrl: string | null): boolean {
  return formUrl !== null && (sameSite(host, new URL(formUrl).hostname) || FORM_BACKENDS.test(host));
}

export interface EnquiryMarkers {
  needles: string[];
  /** The message's longest line; our email only when the message has no line long enough to be ours alone. */
  message: string[];
}

/** Any run of whitespace as one space: a textarea with wrap="hard" breaks long lines (CR LF) as it submits. */
const squash = (s: string) => s.replace(/\s+/g, " ");

/** Our email address and the message's longest line — the two things only our submission contains. */
export function enquiryMarkers(id: { email: string; message: string }): EnquiryMarkers {
  const line = squash(id.message.split(/\r?\n/).reduce((a, b) => (b.trim().length > a.length ? b.trim() : a), ""));
  const email = id.email.toLowerCase();
  const ours = line.length >= 12 ? [line.toLowerCase()] : [];
  return { needles: [email, ...ours], message: ours.length ? ours : [email] };
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    // Not URL-encoded (or malformed): the raw text is checked anyway.
    return s;
  }
};

function holds(text: string, needles: string[]): boolean {
  if (!text) return false;
  const json = text.replace(/\\"/g, '"').replace(/\\u0027/g, "'").replace(/\\[rnt]/g, " ");
  const forms = [text, decode(text), json].map((s) => squash(s.toLowerCase()));
  return needles.some((n) => forms.some((f) => f.includes(n)));
}

export const carriesEnquiry = (text: string, markers: EnquiryMarkers) => holds(text, markers.needles);

/** Stricter: the request carries the message itself (its longest line), not just our email. */
export const carriesMessage = (text: string, markers: EnquiryMarkers) => holds(text, markers.message);

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
