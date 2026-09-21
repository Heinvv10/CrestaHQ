import type { CustomFieldDef, CustomFieldFolder } from "@/types/custom-fields";

export const MAX_FOLDERS_PER_ENTITY = 50;

/** Trimmed folder name, or null when it is empty or over 60 characters. */
export function validateFolderName(v: unknown): string | null {
  const name = typeof v === "string" ? v.trim() : "";
  return name.length >= 1 && name.length <= 60 ? name : null;
}

/**
 * The folder ids after moving the folder at `index` one step up (-1) or
 * down (+1). Works on positions, never on stored `order` values — those go
 * sparse after a delete (2, 3, 4) and index arithmetic on them scrambles
 * the list. The result is sent whole to the reorder route, which renumbers
 * densely.
 */
export function movedFolderIds(
  folders: CustomFieldFolder[],
  index: number,
  dir: -1 | 1,
): string[] | null {
  const target = index + dir;
  if (index < 0 || index >= folders.length || target < 0 || target >= folders.length) {
    return null;
  }
  const ids = folders.map((f) => f.id);
  [ids[index], ids[target]] = [ids[target], ids[index]];
  return ids;
}

export interface CustomFieldGroup {
  /** null = the implicit "General" folder. */
  folder: CustomFieldFolder | null;
  fields: CustomFieldDef[];
}

/**
 * Group field definitions under their folders for rendering: General first,
 * then folders by `order`, fields inside each by `order`. Every folder is
 * returned even when empty (the settings manager needs to show it); display
 * surfaces skip empty groups. A field whose `folderId` points at a folder
 * that no longer exists renders under General rather than vanishing.
 */
export function groupFieldsByFolder(
  defs: CustomFieldDef[],
  folders: CustomFieldFolder[]
): CustomFieldGroup[] {
  const byOrder = <T extends { order: number }>(a: T, b: T) =>
    a.order - b.order;
  const sortedFolders = [...folders].sort(byOrder);
  const known = new Set(sortedFolders.map((f) => f.id));
  const general: CustomFieldDef[] = [];
  const byFolder = new Map<string, CustomFieldDef[]>(
    sortedFolders.map((f) => [f.id, []])
  );
  for (const def of [...defs].sort(byOrder)) {
    const id = def.folderId ?? null;
    if (id && known.has(id)) byFolder.get(id)!.push(def);
    else general.push(def);
  }
  return [
    { folder: null, fields: general },
    ...sortedFolders.map((folder) => ({
      folder,
      fields: byFolder.get(folder.id)!,
    })),
  ];
}
