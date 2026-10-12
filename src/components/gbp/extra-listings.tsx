"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ListingPicker, type SavedExtra } from "./listing-picker";

/**
 * "Additional listings" on the Google Business page: the listings this
 * sub-account manages beside its main one, and — for admins — the multi-select
 * that changes them. The location walk runs only when the admin opens it.
 * A save shows what its 200 stored at once, held until the doc's next
 * snapshot (Firestore's Listen stream can sit silent for ~30 s after a write).
 */
export function ExtraListings({
  subAccountId,
  main,
  extras,
  canEdit,
}: {
  subAccountId: string;
  main: string;
  /** The live doc's `googleExtraListings`, as the snapshot gave it. */
  extras: SavedExtra[] | undefined;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);
  // The last save's answer, pinned to the live extras when it landed: any
  // newer snapshot of them wins over it.
  const [answered, setAnswered] = useState<{ listings: SavedExtra[]; live: SavedExtra[] | undefined } | null>(null);
  const latest = useRef(extras);
  useEffect(() => {
    latest.current = extras;
  }, [extras]);
  const current = answered && answered.live === extras ? answered.listings : (extras ?? []);
  const shown = current.filter((l) => l.locationName !== main);
  return (
    <div className="mt-4 border-t pt-4" data-testid="gbp-extra-listings">
      <p className="mb-2 text-sm font-medium">Additional listings</p>
      {shown.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          None. Other listings under this Google connection can be managed here too.
        </p>
      ) : (
        <ul className="space-y-2">
          {shown.map((l) => (
            <li key={l.locationName} className="text-sm" data-testid="gbp-extra-listing">
              <span className="block font-medium">{l.title}</span>
              <span className="block text-muted-foreground">{l.address || "No storefront address"}</span>
            </li>
          ))}
        </ul>
      )}
      {canEdit &&
        (editing ? (
          <div className="mt-3">
            <ListingPicker
              subAccountId={subAccountId}
              mode="multi"
              main={main}
              selected={shown}
              onSaved={(listings) => setAnswered({ listings, live: latest.current })}
              onClose={() => setEditing(false)}
            />
          </div>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() => setEditing(true)}
            data-testid="gbp-manage-extra-listings"
          >
            Manage additional listings
          </Button>
        ))}
    </div>
  );
}
