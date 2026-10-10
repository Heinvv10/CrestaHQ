"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/dashboard/sidebar";
import { Header } from "@/components/dashboard/header";
import { CommandPalette } from "@/components/search/command-palette";
import { InstallBanner } from "@/components/pwa/install-banner";
import { OfflineBanner } from "@/components/dashboard/offline-banner";
import { BottomTabBar } from "@/components/pwa/bottom-tab-bar";
import { AppBadge } from "@/components/pwa/app-badge";
import { AppAccent } from "@/components/theme/app-accent";
import { SetupSnapshotDialog } from "@/components/agency/setup-snapshot-dialog";
import {
  AgencyBrandingProvider,
  type AgencyBranding,
} from "@/context/agency-branding-context";
import { cn } from "@/lib/utils";

/**
 * The client-side dashboard chrome (sidebar, header, Cmd+K, PWA bits).
 * Extracted from the (dashboard) layout so the layout itself can be a
 * server component (it runs the license gate before rendering this).
 */
export function DashboardAppShell({
  children,
  initialBranding,
}: {
  children: React.ReactNode;
  initialBranding: AgencyBranding | null;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const pathname = usePathname();
  // The bottom tab bar only renders inside a sub-account — reserve space
  // for it (it's position:fixed, so it doesn't push content itself).
  const hasTabBar = /^\/sa\//.test(pathname);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    // h-dvh (not h-screen): 100vh overshoots when mobile browser toolbars
    // or the on-screen keyboard are up, hiding bottom-anchored UI like the
    // conversations composer. Dynamic viewport units track the real height.
    <AgencyBrandingProvider initial={initialBranding}>
      <div className="flex h-dvh">
        <Sidebar open={sidebarOpen} onOpenChange={setSidebarOpen} />
        <div className="flex flex-1 flex-col overflow-hidden">
          <Header
            onMenuClick={() => setSidebarOpen(true)}
            onOpenSearch={() => setSearchOpen(true)}
          />
          <OfflineBanner />
          <InstallBanner />
          <main
            className={cn(
              "flex-1 overflow-y-auto p-4 md:p-6",
              hasTabBar && "pb-24 md:pb-6",
            )}
          >
            {children}
          </main>
        </div>
        <BottomTabBar onMore={() => setSidebarOpen(true)} />
        <AppBadge />
        <AppAccent />
      <SetupSnapshotDialog />
        <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />
      </div>
    </AgencyBrandingProvider>
  );
}
