"use client";

import { BadgeCheck } from "lucide-react";
import { verticalLabel, type WaBusinessProfile } from "./types";

/**
 * WhatsApp's business-info sheet, drawn from the live form state so the
 * operator sees the profile as a customer will while they type it.
 */

function initials(name: string | null): string {
  return (name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";
}

export function PhonePreview({
  profile,
  verifiedName,
  displayPhoneNumber,
}: {
  profile: WaBusinessProfile;
  verifiedName: string | null;
  displayPhoneNumber: string | null;
}) {
  const row = (label: string, value: string) =>
    value ? (
      <div className="border-t px-4 py-2.5">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="whitespace-pre-wrap break-words text-sm">{value}</p>
      </div>
    ) : null;

  return (
    <div
      className="mx-auto w-full max-w-[300px] overflow-hidden rounded-[2rem] border-8 border-neutral-800 bg-background shadow-lg"
      data-testid="wa-preview"
    >
      <div className="bg-[#075e54] px-4 pb-4 pt-6 text-white">
        <div className="flex items-center gap-3">
          {profile.profilePictureUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- Meta CDN / data URL, not a static asset
            <img src={profile.profilePictureUrl} alt="" className="h-14 w-14 rounded-full object-cover" />
          ) : (
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white/20 text-lg font-semibold">
              {initials(verifiedName)}
            </span>
          )}
          <div className="min-w-0">
            <p className="flex items-center gap-1 truncate font-semibold" data-testid="wa-preview-name">
              {verifiedName ?? "Business"}
              <BadgeCheck className="h-4 w-4 shrink-0 text-emerald-300" />
            </p>
            <p className="text-xs text-white/80">Business account</p>
            <p className="text-xs text-white/80">{displayPhoneNumber ?? ""}</p>
          </div>
        </div>
      </div>
      <div className="text-foreground">
        {profile.about && (
          <div className="px-4 py-2.5">
            <p className="text-sm" data-testid="wa-preview-about">{profile.about}</p>
          </div>
        )}
        {row("Description", profile.description)}
        {profile.vertical && profile.vertical !== "UNDEFINED" ? row("Category", verticalLabel(profile.vertical)) : null}
        {row("Address", profile.address)}
        {row("Email", profile.email)}
        {profile.websites.filter(Boolean).map((w) => (
          <div key={w} className="border-t px-4 py-2.5">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Website</p>
            <p className="truncate text-sm text-[#027eb5]">{w}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
