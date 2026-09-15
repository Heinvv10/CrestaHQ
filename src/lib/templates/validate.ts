import {
  TEMPLATE_DESCRIPTION_MAX,
  TEMPLATE_NAME_MAX,
  TEMPLATE_TAGS_MAX,
  TEMPLATE_TAG_MAX,
} from "@/types/templates";

export interface TemplateMeta {
  name?: string;
  description?: string;
  tags?: string[];
}

/**
 * Validate the editable metadata of a library template. Returns only the
 * fields present in `body` (so PATCH can send a subset) or an error string.
 * Tags are trimmed, de-duplicated and emptied of blanks before the cap so
 * `["a", "a", " "]` counts as one tag, not three.
 */
export function parseTemplateMeta(
  body: Record<string, unknown>,
): { ok: true; meta: TemplateMeta } | { ok: false; error: string } {
  const meta: TemplateMeta = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string") {
      return { ok: false, error: "Name must be a string." };
    }
    const name = body.name.trim();
    if (!name || name.length > TEMPLATE_NAME_MAX) {
      return {
        ok: false,
        error: `Name must be 1–${TEMPLATE_NAME_MAX} characters.`,
      };
    }
    meta.name = name;
  }

  if (body.description !== undefined) {
    if (typeof body.description !== "string") {
      return { ok: false, error: "Description must be a string." };
    }
    const description = body.description.trim();
    if (description.length > TEMPLATE_DESCRIPTION_MAX) {
      return {
        ok: false,
        error: `Description must be ${TEMPLATE_DESCRIPTION_MAX} characters or fewer.`,
      };
    }
    meta.description = description;
  }

  if (body.tags !== undefined) {
    if (
      !Array.isArray(body.tags) ||
      body.tags.some((t) => typeof t !== "string")
    ) {
      return { ok: false, error: "Tags must be a list of strings." };
    }
    const tags = [
      ...new Set((body.tags as string[]).map((t) => t.trim()).filter(Boolean)),
    ];
    if (tags.length > TEMPLATE_TAGS_MAX) {
      return { ok: false, error: `At most ${TEMPLATE_TAGS_MAX} tags.` };
    }
    if (tags.some((t) => t.length > TEMPLATE_TAG_MAX)) {
      return {
        ok: false,
        error: `Each tag must be ${TEMPLATE_TAG_MAX} characters or fewer.`,
      };
    }
    meta.tags = tags;
  }

  return { ok: true, meta };
}
