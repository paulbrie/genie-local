import { SlidersHorizontal, UsersRound } from "lucide-react";

/**
 * The Settings app's panes, as its list shows them (settings-nav.tsx) and the command palette finds them (a pane is
 * a page of its own there, "Users" in Settings).
 */
export const SETTINGS_PANES = [
  { href: "/settings", label: "General", icon: SlidersHorizontal, keywords: "appearance theme interface desktop dock icons widgets" },
  { href: "/settings/users", label: "Users", icon: UsersRound, keywords: "people accounts sign in genie google" },
] as const;
