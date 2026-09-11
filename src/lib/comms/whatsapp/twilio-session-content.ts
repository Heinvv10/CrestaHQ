import "server-only";

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { createContentTemplate } from "./templates-api";
import type { WhatsappTemplateDoc } from "@/types/whatsapp-templates";

/**
 * The Twilio Content resource a template's buttons are sent with IN-SESSION.
 *
 * Twilio sends buttons only by ContentSid, and an unapproved Content resource
 * may go in-session with up to 3 quick replies or exactly one link (Twilio
 * Content docs, verified 2026-09-11) — the same rules interactive.ts applies
 * to Cloud. So each button template gets ONE such resource, created on first
 * in-window use and cached on the template doc. It is keyed by a fingerprint
 * of everything Twilio holds (body, language, variable samples, buttons), so
 * an edited draft gets a fresh resource instead of sending the old text.
 *
 * Its body keeps the template's {{1}} placeholders; each send passes the
 * contact's values as contentVariables. Two concurrent first sends may each
 * create one — the loser is an unused resource, never a wrong message.
 */

export function sessionContentFingerprint(tpl: WhatsappTemplateDoc): string {
  const samples = [...(tpl.variables ?? [])]
    .sort((a, b) => a.position - b.position)
    .map((v) => [v.position, v.sampleValue]);
  return createHash("sha256")
    .update(JSON.stringify([tpl.body, tpl.language ?? "en", samples, tpl.buttons ?? []]))
    .digest("hex");
}

export async function ensureTwilioSessionContent(input: {
  subAccountId: string;
  templateId: string;
  template: WhatsappTemplateDoc;
  accountSid: string;
  authToken: string;
}): Promise<string> {
  const fingerprint = sessionContentFingerprint(input.template);
  const cached = input.template.twilioSessionContent;
  if (cached?.sid && cached.fingerprint === fingerprint) return cached.sid;

  const variables: Record<string, string> = {};
  for (const v of input.template.variables ?? []) variables[String(v.position)] = v.sampleValue;
  const { contentSid } = await createContentTemplate({
    accountSid: input.accountSid,
    authToken: input.authToken,
    friendlyName: `session_${input.templateId}_${fingerprint.slice(0, 10)}`,
    language: input.template.language ?? "en",
    body: input.template.body,
    variables,
    buttons: input.template.buttons ?? [],
  });
  await getAdminDb()
    .doc(`subAccounts/${input.subAccountId}/whatsappTemplates/${input.templateId}`)
    .update({
      twilioSessionContent: { sid: contentSid, fingerprint, createdAt: FieldValue.serverTimestamp() },
    });
  return contentSid;
}
