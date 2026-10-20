/** "last: #33 tom tom traffic api · acccess · done": the agent's previous ticket. */
export function LastTicket({ last }: { last: { id: number; title: string; status: string; project: string } | null }) {
  if (!last) return <span className="text-[11px] text-muted-foreground/70">no ticket yet</span>;
  const status = last.status === "in_progress" ? "in progress" : last.status;
  return (
    <span className="truncate text-[11px] text-muted-foreground" title={`#${last.id} ${last.title} · ${last.project} · ${status}`}>
      last: #{last.id} {last.title} · {last.project} · {status}
    </span>
  );
}
