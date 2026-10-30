import type { SnippetInput } from "@/types/snippets";

export const SNIPPET_NAME_MAX = 120;
export const SNIPPET_BODY_MAX = 5000;
export const SNIPPET_SUBJECT_MAX = 200;
export const SNIPPET_FOLDER_MAX = 60;

export type SnippetValidation =
  | { ok: true; value: SnippetInput }
  | { ok: false; error: string };

function text(v: unknown): string | null {
  return typeof v === "string" ? v.trim() : null;
}

/**
 * Validate an untrusted snippet payload. Shared by the API routes (the only
 * write path) and the editor dialog, so both refuse the same things. A text
 * snippet never keeps a subject; an empty folder is stored as null.
 */
export function validateSnippet(raw: unknown): SnippetValidation {
  const r = (raw ?? {}) as Record<string, unknown>;
  const type = r.type;
  if (type !== "text" && type !== "email") {
    return { ok: false, error: "Type must be text or email." };
  }
  const name = text(r.name);
  if (!name) return { ok: false, error: "Name is required." };
  if (name.length > SNIPPET_NAME_MAX) {
    return {
      ok: false,
      error: `Name must be at most ${SNIPPET_NAME_MAX} characters.`,
    };
  }
  const body = text(r.body);
  if (!body) return { ok: false, error: "Body is required." };
  if (body.length > SNIPPET_BODY_MAX) {
    return {
      ok: false,
      error: `Body must be at most ${SNIPPET_BODY_MAX} characters.`,
    };
  }
  let subject: string | null = null;
  if (type === "email") {
    subject = text(r.subject);
    if (!subject) return { ok: false, error: "Email snippets need a subject." };
    if (subject.length > SNIPPET_SUBJECT_MAX) {
      return {
        ok: false,
        error: `Subject must be at most ${SNIPPET_SUBJECT_MAX} characters.`,
      };
    }
  }
  if (r.folder != null && typeof r.folder !== "string") {
    return { ok: false, error: "Folder must be text." };
  }
  const folder = text(r.folder) || null;
  if (folder && folder.length > SNIPPET_FOLDER_MAX) {
    return {
      ok: false,
      error: `Folder must be at most ${SNIPPET_FOLDER_MAX} characters.`,
    };
  }
  return { ok: true, value: { name, body, type, subject, folder } };
}
