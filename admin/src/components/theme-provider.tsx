"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import * as React from "react";

export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      // next-themes injects an inline script that sets the theme before first
      // paint. It must run from the server HTML; when React 19 renders it on
      // the client it warns "Encountered a script tag…". Marking it non-JS on
      // the client silences that without touching the server copy.
      scriptProps={{
        type: typeof window === "undefined" ? undefined : "application/json",
        suppressHydrationWarning: true,
      }}
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
