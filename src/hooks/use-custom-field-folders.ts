"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { subscribeToCustomFieldFolders } from "@/lib/firestore/custom-field-folders";
import type {
  CustomFieldEntity,
  CustomFieldFolder,
} from "@/types/custom-fields";

/** Shown when the folder subscription fails; fields then render flat. */
export const FOLDERS_LOAD_ERROR =
  "Couldn't load custom-field folders — showing fields without them.";

/** Live custom-field folders for one entity in a sub-account. On a
 *  subscription error the list is emptied so fields render flat, and the
 *  operator is told rather than silently seeing everything under General. */
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
      () => {
        setFolders([]);
        toast.error(FOLDERS_LOAD_ERROR);
      }
    );
    return () => unsub();
  }, [subAccountId, entity]);
  return folders;
}
