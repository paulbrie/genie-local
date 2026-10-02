import { ArrowRight, BookOpen, Bot, History, Workflow } from "lucide-react";

import {
  AgentEditor,
  DeleteAgentButton,
  DuplicateAgentButton,
} from "@/components/agent-editor";
import { AgentRunControls } from "@/components/agent-run-controls";
import { Markdown } from "@/components/markdown";
import { RunHistory } from "@/components/run-history";
import { Badge } from "@/components/ui/badge";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
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
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            Documentation
          </code>{" "}
          tab below for the format.
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
          <div className="divide-y rounded-lg border">
            {pipelines.map((p) => (
              <div
                key={p.slug}
                className="flex items-start gap-3 px-3 py-2.5 text-sm"
              >
                <Workflow className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <span className="font-mono font-medium">{p.name}</span>
                  {p.description && (
                    <p className="text-xs text-muted-foreground">
                      {p.description}
                    </p>
                  )}
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
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <AgentRunControls
                    kind="pipeline"
                    slug={p.slug}
                    name={p.name}
                    inputs={p.inputs}
                  />
                  <AgentEditor
                    mode="edit"
                    kind="pipeline"
                    slug={p.slug}
                    agentOptions={agents.map((a) => a.slug)}
                  />
                  <DuplicateAgentButton kind="pipeline" slug={p.slug} />
                  <DeleteAgentButton
                    kind="pipeline"
                    slug={p.slug}
                    name={p.name}
                  />
                </div>
              </div>
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
          <div className="divide-y rounded-lg border">
            {agents.map((a) => (
              <div
                key={a.slug}
                className="flex items-start gap-3 px-3 py-2.5 text-sm"
              >
                <Bot className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-medium">{a.name}</span>
                    {a.model && (
                      <Badge variant="secondary" className="font-normal">
                        {a.model}
                      </Badge>
                    )}
                  </div>
                  {a.description && (
                    <p className="text-xs text-muted-foreground">
                      {a.description}
                    </p>
                  )}
                  {a.inputs.length > 0 && (
                    <FieldRow label="in" values={a.inputs} />
                  )}
                  {a.outputs.length > 0 && (
                    <FieldRow label="out" values={a.outputs} />
                  )}
                  {a.tools && <FieldRow label="tools" values={a.tools} />}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <AgentRunControls
                    kind="agent"
                    slug={a.slug}
                    name={a.name}
                    inputs={a.inputs}
                  />
                  <AgentEditor mode="edit" kind="agent" slug={a.slug} />
                  <DuplicateAgentButton kind="agent" slug={a.slug} />
                  <DeleteAgentButton kind="agent" slug={a.slug} name={a.name} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <Tabs defaultValue="runs">
          <TabsList>
            <TabsTrigger value="runs">
              <History className="size-4" />
              Run history
            </TabsTrigger>
            {readme && (
              <TabsTrigger value="docs">
                <BookOpen className="size-4" />
                Documentation
              </TabsTrigger>
            )}
          </TabsList>
          <TabsContent value="runs" className="pt-3">
            <RunHistory />
          </TabsContent>
          {readme && (
            <TabsContent value="docs" className="pt-3">
              <div className="rounded-lg border bg-card px-4 py-3">
                <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
                  <BookOpen className="size-4" />
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    agents/README.md
                  </code>
                </div>
                <Markdown source={readme} />
              </div>
            </TabsContent>
          )}
        </Tabs>
      </section>
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
