import type { WorkflowFolder } from "@/types/workflows";

export const MAX_WORKFLOW_FOLDERS = 50;

/** Firestore auto-id shape. A client-supplied folder id is interpolated into
 *  a document path, so anything else (a `/` above all) is treated as absent. */
export const isFolderId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);

export interface WorkflowGroup<T> {
  /** null = the implicit "Unfiled" group. */
  folder: WorkflowFolder | null;
  workflows: T[];
}

/**
 * Group workflows under their folders for the list: folders by `order`
 * (then name), Unfiled LAST. Every folder is returned even when empty so it
 * can be renamed or deleted. A workflow with no `folderId` (every doc written
 * before folders existed) or one pointing at a folder that no longer exists
 * lands in Unfiled rather than vanishing. Workflow order is preserved.
 */
export function groupWorkflowsByFolder<T extends { folderId?: string | null }>(
  workflows: T[],
  folders: WorkflowFolder[],
): WorkflowGroup<T>[] {
  const sorted = [...folders].sort(
    (a, b) => a.order - b.order || a.name.localeCompare(b.name),
  );
  const byFolder = new Map<string, T[]>(sorted.map((f) => [f.id, []]));
  const unfiled: T[] = [];
  for (const w of workflows) {
    const bucket = w.folderId ? byFolder.get(w.folderId) : undefined;
    (bucket ?? unfiled).push(w);
  }
  return [
    ...sorted.map((folder) => ({ folder, workflows: byFolder.get(folder.id)! })),
    { folder: null, workflows: unfiled },
  ];
}
