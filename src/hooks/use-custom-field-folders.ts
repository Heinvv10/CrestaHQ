"use client";

import { useEffect, useState } from "react";
import { subscribeToCustomFieldFolders } from "@/lib/firestore/custom-field-folders";
import type {
  CustomFieldEntity,
  CustomFieldFolder,
} from "@/types/custom-fields";

/** Live custom-field folders for one entity in a sub-account. */
export function useCustomFieldFolders(
  subAccountId: string | null | undefined,
  entity: CustomFieldEntity
): CustomFieldFolder[] {
  const [folders, setFolders] = useState<CustomFieldFolder[]>([]);
  useEffect(() => {
    if (!subAccountId) return;
    const unsub = subscribeToCustomFieldFolders(
      subAccountId,
      entity,
      setFolders,
      () => {}
    );
    return () => unsub();
  }, [subAccountId, entity]);
  return folders;
}
