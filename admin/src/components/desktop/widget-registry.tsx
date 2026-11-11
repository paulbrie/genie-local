"use client";

import { FolderKanban, Gauge, GitBranch, HardDrive, HeartPulse, KeyRound, ListTodo, type LucideIcon, MemoryStick, SquareTerminal, TriangleAlert } from "lucide-react";

import { ErrorsWidget, GitWidget, HealthWidget, LoadWidget, MemoryWidget, SigninsWidget, TicketsWidget } from "@/components/desktop/more-widgets";
import { DiskWidget, ProjectsWidget, TerminalsWidget } from "@/components/desktop/status-widget";
import type { WidgetId } from "@/lib/desktop";

/** Each widget's glyph, as its header and the menus that show or hide it have it. */
export const WIDGET_ICON: Record<WidgetId, LucideIcon> = {
  terminals: SquareTerminal,
  projects: FolderKanban,
  disk: HardDrive,
  memory: MemoryStick,
  health: HeartPulse,
  errors: TriangleAlert,
  git: GitBranch,
  load: Gauge,
  tickets: ListTodo,
  signins: KeyRound,
};

/** What each widget holds, by id (its frame is desktop.tsx's WidgetFrame). */
export const WIDGET_BODY: Record<WidgetId, (p: { folded: boolean }) => React.ReactNode> = {
  terminals: TerminalsWidget,
  projects: ProjectsWidget,
  disk: DiskWidget,
  memory: MemoryWidget,
  health: HealthWidget,
  errors: ErrorsWidget,
  git: GitWidget,
  load: LoadWidget,
  tickets: TicketsWidget,
  signins: SigninsWidget,
};
