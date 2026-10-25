import { BoardsManager } from "@/components/boards/boards-manager";
import { listBoards } from "@/lib/boards/db";

export const dynamic = "force-dynamic";

export default async function BoardsPage() {
  const [boards, archived] = await Promise.all([listBoards(), listBoards(true)]);
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Boards</h1>
        <p className="text-sm text-muted-foreground">
          Shared whiteboards: stickies, shapes, connectors, drawing, comments, votes and a timer, live with everyone on
          the admin. Claude joins in when you ask it, when you @claude it in a comment, or as a facilitator. Agents can
          edit boards through <span className="font-mono">/api/boards</span>.
        </p>
      </header>
      <BoardsManager initial={boards} initialArchived={archived} />
    </main>
  );
}
