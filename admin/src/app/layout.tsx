import type { Metadata } from "next";
import { Fredoka, Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { ActivityBeacon } from "@/components/activity-beacon";
import { AskHost } from "@/components/ask-host";
import { AppShell } from "@/components/desktop/app-shell";
import { RunDock } from "@/components/run-dock";
import { JarvisConsole } from "@/components/jarvis-console";
import { JarvisOrb } from "@/components/jarvis-orb";
import { ProjectMemoryMonitor } from "@/components/project-memory-monitor";
import { TerminalDock } from "@/components/terminal-dock";
import { TerminalNarrator } from "@/components/terminal-narrator";
import { TerminalVoiceMonitor } from "@/components/terminal-voice-monitor";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { UploadDock } from "@/components/upload-dock";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// The Spiridus wordmark face (SemiBold only: it sets just "spiridus").
const fredoka = Fredoka({
  variable: "--font-fredoka",
  subsets: ["latin"],
  weight: "600",
});

/**
 * The tab title names the box: "<who> - Genie", where <who> is the first label
 * of its public host (paul.cloud.teleporthq.ai → "paul - Genie"). APP_TITLE
 * overrides it.
 */
function appTitle(): string {
  if (process.env.APP_TITLE) return process.env.APP_TITLE;
  const who = process.env.PUBLIC_HOST?.split(".")[0]?.trim();
  return who ? `${who} - Genie` : "Genie";
}

export function generateMetadata(): Metadata {
  return {
    title: appTitle(),
    description: "Supervise all projects under /opt/project/projects",
  };
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // A page in one of the desktop's windows (a frame, components/desktop): just the page, none of the frame around it,
  // and none of what the page it's in runs already (terminals, voice, alerts, activity), which would happen twice.
  const embedded = (await headers()).get("sec-fetch-dest") === "iframe";
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${fredoka.variable} h-full antialiased`}
    >
      <body className="h-full">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <AppShell embedded={embedded}>
            {children}
          </AppShell>
          {!embedded && (
            <>
              <TerminalDock />
              <TerminalVoiceMonitor />
              <TerminalNarrator />
              <JarvisOrb />
              <JarvisConsole />
              <RunDock />
            </>
          )}
          <UploadDock />
          <AskHost />
          {!embedded && (
            <>
              <ProjectMemoryMonitor />
              <ActivityBeacon />
            </>
          )}
          <Toaster richColors position="top-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
