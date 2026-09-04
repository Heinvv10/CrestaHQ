import "server-only";

import type {
  WhatsappTemplateCategory,
  WhatsappTemplateStatus,
  WhatsappTemplateVariable,
} from "@/types/whatsapp-templates";
import type { WhatsappCloudSecret } from "@/types/whatsapp-cloud";

/**
 * Template management against the Meta Graph API — the `cloud` rail's
 * equivalent of `templates-api.ts` (which talks to Twilio's Content API).
 *
 * Templates belong to a WABA, so these calls address `wabaId`, not the
 * phone-number id used for sending. The two are adjacent in Meta's dashboard
 * and easy to transpose, which produces a 404 that says nothing useful.
 */

function graphVersion(): string {
  return process.env.WHATSAPP_GRAPH_VERSION ?? "v23.0";
}

/** Meta echoes tokens back in some auth errors, and these messages are shown
 *  to operators and written to logs. */
function redact(text: string, accessToken: string): string {
  return accessToken ? text.split(accessToken).join("[redacted]") : text;
}

export class CloudTemplateError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CloudTemplateError";
  }
}

/** Pull Meta's human-readable reason out of a Graph error body. */
function describeGraphError(raw: string, accessToken: string): string {
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

export interface MetaTemplateComponent {
  type: "BODY";
  text: string;
  example?: { body_text: string[][] };
}

/**
 * Our stored template → Meta's component shape.
 *
 * Two things Meta is strict about. Samples go in ONE row
 * (`[[first, second]]`), not one row per variable. And a template with no
 * variables must omit `example` entirely rather than send an empty array.
 *
 * Sorted by `position` because the builder stores variables in edit order
 * while Meta reads them positionally — an unsorted array approves the
 * template with its arguments transposed, which is worse than a rejection
 * because it looks like it worked.
 */
export function buildMetaTemplateComponents(
  body: string,
  variables: WhatsappTemplateVariable[],
): MetaTemplateComponent[] {
  const ordered = [...variables].sort((a, b) => a.position - b.position);
  const component: MetaTemplateComponent = { type: "BODY", text: body };
  if (ordered.length > 0) {
    component.example = { body_text: [ordered.map((v) => v.sampleValue)] };
  }
  return [component];
}

/**
 * Meta's template states → ours. An unrecognised state maps to `pending`, not
 * `approved`: Meta adds states over time, and guessing "approved" would let
 * the send path fire a template Meta has not cleared. Pending merely keeps
 * polling.
 */
export function mapMetaTemplateStatus(
  raw: string | null | undefined,
): WhatsappTemplateStatus {
  switch ((raw ?? "").toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "REJECTED":
      return "rejected";
    case "PAUSED":
      return "paused";
    case "DISABLED":
      return "disabled";
    default:
      return "pending";
  }
}

export async function createCloudTemplate(
  creds: WhatsappCloudSecret,
  input: {
    name: string;
    language: string;
    category: WhatsappTemplateCategory;
    body: string;
    variables: WhatsappTemplateVariable[];
  },
): Promise<{ id: string; status: WhatsappTemplateStatus }> {
  const url = `https://graph.facebook.com/${graphVersion()}/${creds.wabaId}/message_templates`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: input.name,
      language: input.language,
      category: input.category,
      components: buildMetaTemplateComponents(input.body, input.variables),
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => "unknown error");
    throw new CloudTemplateError(
      describeGraphError(raw, creds.accessToken),
      res.status,
    );
  }

  const data = (await res.json()) as { id?: string; status?: string };
  const id = data.id?.trim();
  if (!id) {
    // An empty external id would make the registration look real while being
    // unsendable — the send path would take its template branch and fail.
    throw new CloudTemplateError(
      "Meta accepted the template but returned it without a template id",
      res.status,
    );
  }
  return { id, status: mapMetaTemplateStatus(data.status) };
}

/**
 * Current approval state for one template name. Returns null when Meta does
 * not know the name — treated by the caller as "keep waiting", since a
 * just-submitted template can briefly not be listed.
 */
export async function fetchCloudTemplateStatus(
  creds: WhatsappCloudSecret,
  name: string,
): Promise<{ status: WhatsappTemplateStatus; reason: string | null } | null> {
  const url =
    `https://graph.facebook.com/${graphVersion()}/${creds.wabaId}/message_templates` +
    `?name=${encodeURIComponent(name)}&fields=name,status,id,rejected_reason&limit=5`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => "unknown error");
    throw new CloudTemplateError(
      describeGraphError(raw, creds.accessToken),
      res.status,
    );
  }
  const data = (await res.json()) as {
    data?: Array<{ name?: string; status?: string; rejected_reason?: string }>;
  };
  // Meta's `name` filter is a prefix match, so an exact comparison is needed:
  // querying "quote" would otherwise return "quote_reminder" and report the
  // wrong template's status.
  const match = data.data?.find((t) => t.name === name);
  if (!match) return null;
  const reason = match.rejected_reason?.trim();
  return {
    status: mapMetaTemplateStatus(match.status),
    reason: reason && reason.toUpperCase() !== "NONE" ? reason : null,
  };
}
