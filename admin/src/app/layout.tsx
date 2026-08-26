import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AppSidebar } from "@/components/app-sidebar";
import { RunDock } from "@/components/run-dock";
import { StatsToolbar } from "@/components/stats-toolbar";
import { TerminalDock } from "@/components/terminal-dock";
import { TerminalVoiceMonitor } from "@/components/terminal-voice-monitor";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Projects Supervisor",
  description: "Supervise all projects under /opt/project/projects",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="h-full">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <div className="flex h-screen overflow-hidden">
            <AppSidebar />
            <div className="flex min-w-0 flex-1 flex-col">
              <StatsToolbar />
              <div className="flex-1 overflow-y-auto">{children}</div>
            </div>
          </div>
          <TerminalDock />
          <TerminalVoiceMonitor />
          <RunDock />
          <Toaster richColors position="top-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
