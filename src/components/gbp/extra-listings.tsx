"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ListingPicker, type SavedExtra } from "./listing-picker";

/** Which listings, in which order — what a snapshot and an answer are compared by. */
const keysOf = (list: SavedExtra[] | undefined) => (list ?? []).map((l) => `${l.accountName}|${l.locationName}`).join(",");

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
  // The last save's answer, held while the live extras are still what they
  // were when it landed (`pinned`). Dropped — for good — once they equal the
  // answer (the snapshot caught up) or differ from both (someone else
  // changed them). Compared by content: a snapshot of an unrelated write
  // still brings a new array.
  const [answered, setAnswered] = useState<{ listings: SavedExtra[]; pinned: string } | null>(null);
  const latest = useRef(extras);
  useEffect(() => {
    latest.current = extras;
  }, [extras]);
  const live = keysOf(extras);
  const holding = answered !== null && live === answered.pinned && live !== keysOf(answered.listings);
  useEffect(() => {
    if (answered && !holding) setAnswered(null);
  }, [answered, holding]);
  const current = holding ? answered.listings : (extras ?? []);
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
              onSaved={(listings) => setAnswered({ listings, pinned: keysOf(latest.current) })}
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
