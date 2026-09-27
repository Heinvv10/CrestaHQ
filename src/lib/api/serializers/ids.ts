import { isDocId } from "@/lib/server/doc-id";

/**
 * A body id that reaches `db.doc` must be a doc id (see isDocId): the
 * parse failure the routes answer as 400 invalid_id. "" / null means "no
 * link" and is left to the caller.
 */
export function badBodyId(field: string, id: string | null | undefined) {
  return id && !isDocId(id)
    ? { ok: false as const, code: "invalid_id" as const, error: `\`${field}\` is not a valid id.` }
    : null;
}
