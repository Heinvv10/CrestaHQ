"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { GoogleListing } from "@/types/google";
import { ListingPicker } from "./listing-picker";

/**
 * "Additional listings" on the Google Business page: the listings this
 * sub-account manages beside its main one, and — for admins — the multi-select
 * that changes them. The location walk runs only when the admin opens it.
 */
export function ExtraListings({
  subAccountId,
  main,
  extras,
  canEdit,
}: {
  subAccountId: string;
  main: string;
  extras: GoogleListing[];
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const shown = extras.filter((l) => l.locationName !== main);
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
