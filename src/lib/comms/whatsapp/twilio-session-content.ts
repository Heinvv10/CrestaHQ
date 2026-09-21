import "server-only";

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { createContentTemplate, WhatsappContentError } from "./templates-api";
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
 * The fingerprint includes the Twilio account the resource lives on, so a
 * tenant that moves accounts gets a fresh one instead of a sid the new account
 * has never seen. A resource deleted in the Twilio console is NOT detected:
 * sends fail, loudly in the run log, until the cache is cleared — delete the
 * doc's `twilioSessionContent` field, or duplicate the template and repoint
 * the step. Editing is no remedy for a pending/approved template: those are
 * locked (the edit route answers 409).
 *
 * Its body keeps the template's {{1}} placeholders; each send passes the
 * contact's values as contentVariables. Every in-window send that reads the
 * doc before the first write lands creates its own resource — the extras are
 * unused, never a wrong message.
 */

export function sessionContentFingerprint(
  tpl: WhatsappTemplateDoc,
  accountSid: string,
): string {
  const samples = [...(tpl.variables ?? [])]
    .sort((a, b) => a.position - b.position)
    .map((v) => [v.position, v.sampleValue]);
  return createHash("sha256")
    .update(JSON.stringify([accountSid, tpl.body, tpl.language ?? "en", samples, tpl.buttons ?? []]))
    .digest("hex");
}

export async function ensureTwilioSessionContent(input: {
  subAccountId: string;
  templateId: string;
  template: WhatsappTemplateDoc;
  accountSid: string;
  authToken: string;
}): Promise<string> {
  const fingerprint = sessionContentFingerprint(input.template, input.accountSid);
  const cached = input.template.twilioSessionContent;
  if (cached?.sid && cached.fingerprint === fingerprint) return cached.sid;

  const variables: Record<string, string> = {};
  for (const v of input.template.variables ?? []) variables[String(v.position)] = v.sampleValue;
  let contentSid: string;
  try {
    ({ contentSid } = await createContentTemplate({
      accountSid: input.accountSid,
      authToken: input.authToken,
      friendlyName: `session_${input.templateId}_${fingerprint.slice(0, 10)}`,
      language: input.template.language ?? "en",
      body: input.template.body,
      variables,
      buttons: input.template.buttons ?? [],
    }));
  } catch (err) {
    // Keep Twilio's own reason — the bare message tells an operator nothing.
    if (err instanceof WhatsappContentError) {
      throw new Error(`${err.message} (${err.status}): ${(err.body ?? "").slice(0, 200)}`);
    }
    throw err;
  }
  await getAdminDb()
    .doc(`subAccounts/${input.subAccountId}/whatsappTemplates/${input.templateId}`)
    .update({
      twilioSessionContent: { sid: contentSid, fingerprint, createdAt: FieldValue.serverTimestamp() },
    });
  return contentSid;
}
