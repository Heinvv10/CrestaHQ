"use client";

import { ThemeProvider, useTheme } from "next-themes";
import { Toaster } from "sonner";
import { AuthProvider } from "@/context/auth-context";
import { FirestoreCrashBanner } from "@/components/firestore-crash-banner";

function ThemedToaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      position="top-right"
      richColors
      closeButton
      theme={resolvedTheme === "dark" ? "dark" : "light"}
    />
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <AuthProvider>
        <FirestoreCrashBanner />
        {children}
        <ThemedToaster />
      </AuthProvider>
    </ThemeProvider>
  );
}
