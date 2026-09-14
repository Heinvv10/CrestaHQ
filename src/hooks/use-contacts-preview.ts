"use client";

import { useEffect, useState } from "react";
import { fetchNewestContacts } from "@/lib/firestore/contacts";
import type { Contact } from "@/types/contacts";
import type { TenantScope } from "@/types";

/**
 * The newest `count` contacts, fetched once while `enabled` — a first paint
 * for the contacts page while the full list is still downloading (3.8s on a
 * 4,551-contact sub-account). Returns null when disabled, before it lands,
 * or if the fetch fails; a result that lands after `enabled` flips off (the
 * full list won the race) or the scope changed is dropped.
 */
export function useContactsPreview(
  scope: TenantScope | null,
  count: number,
  enabled: boolean,
): Contact[] | null {
  const [preview, setPreview] = useState<Contact[] | null>(null);
  const agencyId = scope?.agencyId ?? null;
  const subAccountId = scope?.subAccountId ?? null;

  useEffect(() => {
    setPreview(null);
    if (!enabled || !agencyId || !subAccountId) return;
    let live = true;
    fetchNewestContacts({ agencyId, subAccountId }, count)
      .then((list) => {
        if (live) setPreview(list);
      })
      .catch((err) => {
        // Best-effort: the full list still loads, only the early paint is lost.
        console.warn("[contacts] first-page preview failed", err);
      });
    return () => {
      live = false;
    };
  }, [enabled, agencyId, subAccountId, count]);

  return preview;
}
