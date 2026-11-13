// A project page's tabs (/projects/<slug>/<tab>), in the tab bar's order: pure, for server and client alike
// (project-page.ts re-exports them; the command palette lists them).
export const PROJECT_TABS = ["scripts", "production", "vercel", "tasks", "notes", "memory", "files", "next", "git"] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];

export const PROJECT_TAB_LABELS: Record<ProjectTab, string> = {
  scripts: "Scripts",
  production: "Production",
  vercel: "Vercel",
  tasks: "Tasks",
  notes: "Notes",
  memory: "Memory",
  files: "Files",
  next: "Next.js",
  git: "Git",
};
