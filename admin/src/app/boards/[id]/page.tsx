import { notFound } from "next/navigation";

import { BoardApp } from "@/components/boards/board-app";
import { getBoard, parseBoardId } from "@/lib/boards/db";

export const dynamic = "force-dynamic";

/** /boards/<id>: the live whiteboard, filling the content area. */
export default async function BoardPage({ params }: { params: Promise<{ id: string }> }) {
  const id = parseBoardId((await params).id);
  const board = id === null ? null : await getBoard(id);
  if (!board || board.archivedAt) notFound();
  return (
    <main className="relative h-full overflow-hidden">
      <BoardApp boardId={board.id} initialTitle={board.title} />
    </main>
  );
}
