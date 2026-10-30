"use client";

import Link from "next/link";
import { LogoMark } from "@/components/brand/logo-mark";

/**
 * Sidebar logo + wordmark. Until the agency's branding is known (`ready`),
 * paints a neutral same-size box and no name, so the template's default
 * LogoMark / brand name never flashes before the agency's own.
 */
export function SidebarBrand({
  name,
  logoUrl,
  ready,
}: {
  name: string;
  logoUrl: string | null;
  ready: boolean;
}) {
  return (
    <Link href="/" className="flex items-center gap-2 text-xl font-bold">
      {logoUrl ? (
        // Custom agency logo. Constrained to 24px tall, auto width;
        // the agency hosts the asset so we render whatever they paste.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          alt={name}
          className="h-6 w-auto max-w-[120px] object-contain"
        />
      ) : ready ? (
        <LogoMark size={20} idSuffix="-sidebar" />
      ) : (
        <span
          data-testid="sidebar-brand-placeholder"
          aria-hidden="true"
          className="bg-muted size-5 rounded"
        />
      )}
      {ready && <span className="truncate">{name}</span>}
    </Link>
  );
}
