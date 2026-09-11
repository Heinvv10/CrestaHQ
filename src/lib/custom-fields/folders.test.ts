import { describe, expect, it } from "vitest";
import { groupFieldsByFolder, movedFolderIds } from "./folders";
import type { CustomFieldDef, CustomFieldFolder } from "@/types/custom-fields";

const def = (id: string, order: number, folderId?: string | null) =>
  ({ id, key: id, label: id, order, folderId }) as CustomFieldDef;
const folder = (id: string, order: number) =>
  ({ id, name: id, order }) as CustomFieldFolder;

describe("groupFieldsByFolder", () => {
  it("puts General first, then folders by order, fields by order", () => {
    const groups = groupFieldsByFolder(
      [
        def("b", 2, "f2"),
        def("a", 1, "f2"),
        def("g2", 5),
        def("g1", 0, null),
        def("c", 0, "f1"),
      ],
      [folder("f2", 1), folder("f1", 0)]
    );
    expect(groups.map((g) => g.folder?.id ?? null)).toEqual([null, "f1", "f2"]);
    expect(groups.map((g) => g.fields.map((f) => f.id))).toEqual([
      ["g1", "g2"],
      ["c"],
      ["a", "b"],
    ]);
  });

  it("returns empty folders so the manager can show them", () => {
    const groups = groupFieldsByFolder([], [folder("f1", 0)]);
    expect(groups).toEqual([
      { folder: null, fields: [] },
      { folder: folder("f1", 0), fields: [] },
    ]);
  });

  it("falls a field back to General when its folder is missing", () => {
    const groups = groupFieldsByFolder(
      [def("x", 0, "gone")],
      [folder("f1", 0)]
    );
    expect(groups[0].fields.map((f) => f.id)).toEqual(["x"]);
    expect(groups[1].fields).toEqual([]);
  });
});

describe("movedFolderIds", () => {
  // Sparse orders left behind by a delete: C=2, D=3, E=4.
  const sparse = [folder("C", 2), folder("D", 3), folder("E", 4)];

  it("swaps by position, not by stored order value", () => {
    expect(movedFolderIds(sparse, 1, 1)).toEqual(["C", "E", "D"]);
    expect(movedFolderIds(sparse, 2, -1)).toEqual(["C", "E", "D"]);
  });

  it("refuses moves off either end", () => {
    expect(movedFolderIds(sparse, 0, -1)).toBeNull();
    expect(movedFolderIds(sparse, 2, 1)).toBeNull();
  });
});
