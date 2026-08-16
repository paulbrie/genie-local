import { ArrowRight, BookOpen, Bot, History, Workflow } from "lucide-react";

import { AgentEditor, DeleteAgentButton } from "@/components/agent-editor";
import { AgentRunControls } from "@/components/agent-run-controls";
import { Markdown } from "@/components/markdown";
import { RunHistory } from "@/components/run-history";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AGENTS_ROOT,
  listAgents,
  listPipelines,
  readAgentsReadme,
} from "@/lib/agents";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const [agents, pipelines, readme] = await Promise.all([
    listAgents(),
    listPipelines(),
    readAgentsReadme(),
  ]);

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 space-y-8 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
        <p className="text-sm text-muted-foreground">
          Markdown-defined agents and pipelines from{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            {AGENTS_ROOT}
          </code>
          . Create, edit, run, and delete them here; see the{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">README.md</code>{" "}
          below for the format.
        </p>
      </header>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="flex items-center gap-2 text-lg font-medium">
            <Workflow className="size-4 text-muted-foreground" />
            Pipelines
            <Badge variant="secondary">{pipelines.length}</Badge>
          </h2>
          <AgentEditor
            mode="create"
            kind="pipeline"
            className="ml-auto"
            agentOptions={agents.map((a) => a.slug)}
          />
        </div>
        {pipelines.length === 0 ? (
          <EmptyState label="No pipelines defined yet." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {pipelines.map((p) => (
              <Card key={p.slug}>
                <CardHeader>
                  <CardTitle className="font-mono">{p.name}</CardTitle>
                  <CardDescription>{p.description}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {p.inputs.length > 0 && (
                    <FieldRow label="inputs" values={p.inputs} />
                  )}
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    {p.steps.map((s, i) => (
                      <span key={i} className="flex items-center gap-1.5">
                        <Badge variant="outline" className="font-mono">
                          {s.as ? `${s.as} · ${s.agent}` : s.agent}
                        </Badge>
                        {i < p.steps.length - 1 && (
                          <ArrowRight className="size-3 text-muted-foreground" />
                        )}
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center justify-between gap-2 border-t pt-3">
                    <AgentRunControls
                      kind="pipeline"
                      slug={p.slug}
                      name={p.name}
                      inputs={p.inputs}
                    />
                    <div className="flex items-center">
                      <AgentEditor
                        mode="edit"
                        kind="pipeline"
                        slug={p.slug}
                        agentOptions={agents.map((a) => a.slug)}
                      />
                      <DeleteAgentButton
                        kind="pipeline"
                        slug={p.slug}
                        name={p.name}
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="flex items-center gap-2 text-lg font-medium">
            <Bot className="size-4 text-muted-foreground" />
            Agents
            <Badge variant="secondary">{agents.length}</Badge>
          </h2>
          <AgentEditor mode="create" kind="agent" className="ml-auto" />
        </div>
        {agents.length === 0 ? (
          <EmptyState label="No agents defined yet." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {agents.map((a) => (
              <Card key={a.slug}>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-2 font-mono">
                    {a.name}
                    {a.model && (
                      <Badge variant="secondary" className="font-normal">
                        {a.model}
                      </Badge>
                    )}
                  </CardTitle>
                  <CardDescription>{a.description}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {a.inputs.length > 0 && (
                    <FieldRow label="in" values={a.inputs} />
                  )}
                  {a.outputs.length > 0 && (
                    <FieldRow label="out" values={a.outputs} />
                  )}
                  {a.tools && <FieldRow label="tools" values={a.tools} />}
                  <div className="flex items-center justify-between gap-2 border-t pt-2">
                    <AgentRunControls
                      kind="agent"
                      slug={a.slug}
                      name={a.name}
                      inputs={a.inputs}
                    />
                    <div className="flex items-center">
                      <AgentEditor mode="edit" kind="agent" slug={a.slug} />
                      <DeleteAgentButton
                        kind="agent"
                        slug={a.slug}
                        name={a.name}
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-medium">
          <History className="size-4 text-muted-foreground" />
          Run history
        </h2>
        <RunHistory />
      </section>

      {readme && (
        <section>
          <details open className="rounded-lg border bg-card">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-lg font-medium select-none">
              <BookOpen className="size-4 text-muted-foreground" />
              README
              <code className="ml-auto rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-normal text-muted-foreground">
                agents/README.md
              </code>
            </summary>
            <div className="border-t px-4 py-3">
              <Markdown source={readme} />
            </div>
          </details>
        </section>
      )}
    </main>
  );
}

function FieldRow({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="w-10 shrink-0 text-muted-foreground">{label}</span>
      <span className="flex flex-wrap gap-1">
        {values.map((v) => (
          <Badge key={v} variant="outline" className="font-mono font-normal">
            {v}
          </Badge>
        ))}
      </span>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}
