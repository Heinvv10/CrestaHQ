"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { LANDING_VARIANT } from "@/config/landing";

/**
 * "leadstack" (demo/template) mode ONLY: injects the PWA install links
 * (<link rel="manifest"> + apple-touch-icon + iOS standalone metas) on
 * AUTH surfaces — sign-in/sign-up and the dashboard — and nowhere else.
 *
 * Why: installability is evaluated per page from the links on the current
 * document, so keeping them off the public routes means the LeadStack
 * sales/landing pages carry zero PWA surface (no browser install prompt,
 * no behavior change), while a signed-in operator can still install and
 * test the app. In "custom" mode this component is a no-op — the buyer
 * deployment declares the manifest site-wide via root-layout metadata.
 */

const AUTH_SURFACE_PREFIXES = [
  "/login",
  "/signup",
  "/sa/",
  "/agency",
  "/me/",
  "/dashboard",
  "/contacts",
  "/pipeline",
  "/calendar",
  "/tasks",
  "/forms",
  "/reports",
  "/conversations",
];

function isAuthSurface(pathname: string): boolean {
  return AUTH_SURFACE_PREFIXES.some(
    (p) => pathname === p.replace(/\/$/, "") || pathname.startsWith(p),
  );
}

export function PwaLinks() {
  const pathname = usePathname();
  const active = LANDING_VARIANT !== "custom" && isAuthSurface(pathname ?? "");

  useEffect(() => {
    if (!active) return;
    const els: HTMLElement[] = [];
    const add = (tag: "link" | "meta", attrs: Record<string, string>) => {
      const el = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      document.head.appendChild(el);
      els.push(el);
    };
    add("link", { rel: "manifest", href: "/manifest.webmanifest" });
    // Via the serving route so an owner-uploaded icon applies to the test
    // install too; 302s to the chevron default until one exists.
    add("link", { rel: "apple-touch-icon", href: "/api/pwa/icon/apple" });
    add("meta", { name: "apple-mobile-web-app-capable", content: "yes" });
    add("meta", { name: "apple-mobile-web-app-title", content: "LeadStack" });
    return () => {
      for (const el of els) el.remove();
    };
  }, [active]);

  return null;
}
