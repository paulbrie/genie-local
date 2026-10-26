import { notFound } from "next/navigation";

import { BoardApp } from "@/components/boards/board-app";
import { BoardTabs } from "@/components/boards/board-tabs";
import { getBoard, parseBoardId } from "@/lib/boards/db";

export const dynamic = "force-dynamic";

/** /boards/<id>: the live whiteboard under the open boards' tabs, filling the content area. */
export default async function BoardPage({ params }: { params: Promise<{ id: string }> }) {
  const id = parseBoardId((await params).id);
  const board = id === null ? null : await getBoard(id);
  if (!board || board.archivedAt) notFound();
  return (
    <main className="flex h-full flex-col overflow-hidden">
      <BoardTabs current={board.id} title={board.title} />
      <div className="relative min-h-0 flex-1">
        <BoardApp key={board.id} boardId={board.id} initialTitle={board.title} />
      </div>
    </main>
  );
}
