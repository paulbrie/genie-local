import {
  Activity,
  Bot,
  Box,
  BrickWallShield,
  ChefHat,
  Container,
  Database,
  Globe,
  MousePointerClick,
  KanbanSquare,
  KeyRound,
  LayoutDashboard,
  UsersRound,
  MessagesSquare,
  Network,
  FolderOpen,
  FolderKanban,
  ScrollText,
  Server,
  Settings,
  Share2,
  StickyNote,
  Sparkles,
  SquareTerminal,
  TrainFront,
} from "lucide-react";

/**
 * The app's areas, as the classic sidebar (app-sidebar.tsx) lists them and the
 * desktop (components/desktop) lays them out as icons. One list, so a new page
 * shows up in both.
 */
export type NavItem = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  exact?: boolean;
  /** A collapsible group: the item itself links to its own page, these under it. */
  children?: NavItem[];
};

export const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, exact: true },
  // Its sub-items are the projects themselves (ProjectsGroup), loaded live.
  { href: "/projects", label: "Projects", icon: FolderKanban, exact: true },
  { href: "/terminals", label: "Terminals", icon: SquareTerminal },
  { href: "/boards", label: "Boards", icon: StickyNote },
  { href: "/files", label: "Files", icon: FolderOpen },
  { href: "/db", label: "DB Explorer", icon: Database },
  { href: "/processes", label: "Processes", icon: Activity },
  { href: "/chrome", label: "Chrome", icon: Globe },
  { href: "/browsers", label: "Browsers", icon: MousePointerClick },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/docker", label: "Docker", icon: Container },
  { href: "/services", label: "Services", icon: Server },
  { href: "/nginx", label: "Nginx", icon: Network },
  { href: "/firewall", label: "Firewall", icon: BrickWallShield },
  { href: "/railway", label: "Railway", icon: TrainFront },
  { href: "/diagrams", label: "Diagrams", icon: Share2 },
  { href: "/recipes", label: "Recipes", icon: ChefHat },
  { href: "/logs", label: "Logs", icon: ScrollText },
  { href: "/logins", label: "Logins", icon: KeyRound },
  { href: "/claude", label: "Claude", icon: Sparkles },
  {
    href: "/teams",
    label: "Team",
    icon: UsersRound,
    exact: true,
    children: [
      { href: "/comms", label: "Comms", icon: MessagesSquare },
      { href: "/agents3d", label: "Agents City", icon: Box },
      { href: "/tasks", label: "Tasks", icon: KanbanSquare },
    ],
  },
  { href: "/settings", label: "Settings", icon: Settings },
];

export const isActive = (item: NavItem, pathname: string) =>
  item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(`${item.href}/`);

/** Every page as one list, a group's children after it: the desktop's icons. */
export const NAV_FLAT: NavItem[] = NAV.flatMap((i) => [i, ...(i.children ?? [])]);
export const NAV_HREFS = NAV_FLAT.map((i) => i.href);
