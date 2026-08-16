"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  ChevronUp,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import {
  deleteAgentSourceAction,
  getAgentDefAction,
  saveAgentDefAction,
} from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import type { Agent, Pipeline } from "@/lib/agents";

type Kind = "agent" | "pipeline";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const SELECT_CLS =
  "h-8 rounded-md border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

const KNOWN_MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
  "claude-fable-5",
];
const TOOL_SUGGESTIONS = [
  "Read",
  "Write",
  "Edit",
  "Grep",
  "Glob",
  "Bash",
  "WebSearch",
  "WebFetch",
  "mcp__agent-browser",
];

type AData = {
  name: string;
  description: string;
  model: string; // "" = inherit
  tools: string[]; // [] = omit (read-only default)
  inputs: string[];
  outputs: string[];
  body: string;
};
type PData = {
  name: string;
  description: string;
  inputs: string[];
  steps: { agent: string; as: string }[];
  body: string;
};

const defaultAgent = (): AData => ({
  name: "",
  description: "",
  model: "claude-opus-4-8",
  tools: ["Read", "WebSearch", "WebFetch"],
  inputs: ["topic"],
  outputs: ["result"],
  body:
    "You are a meticulous assistant.\n\nGiven **{{topic}}**, do the work and " +
    "return your answer as the `result` output.",
});
const defaultPipeline = (agentOptions: string[]): PData => ({
  name: "",
  description: "",
  inputs: ["topic"],
  steps: [{ agent: agentOptions[0] ?? "", as: "" }],
  body: "Research the topic, then draft an article from the findings.",
});

/**
 * Visual create/edit for one markdown-defined agent or pipeline. Every part of
 * the file is edited through form controls (fields, a tool/input/output token
 * picker, and — for pipelines — an ordered step builder that only lets you pick
 * real agents), and is serialized back into the exact frontmatter format on the
 * server, so the file can't be malformed.
 */
export function AgentEditor({
  mode,
  kind,
  slug,
  className,
  agentOptions = [],
}: {
  mode: "create" | "edit";
  kind: Kind;
  slug?: string;
  className?: string;
  agentOptions?: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [slugValue, setSlugValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, startSave] = useTransition();
  const [a, setA] = useState<AData>(defaultAgent);
  const [p, setP] = useState<PData>(() => defaultPipeline(agentOptions));

  useEffect(() => {
    if (!open) return;
    if (mode === "edit" && slug) {
      setLoading(true);
      getAgentDefAction(kind, slug)
        .then((def) => {
          if (kind === "pipeline") {
            const d = def as Pipeline;
            setP({
              name: d.name,
              description: d.description,
              inputs: d.inputs,
              steps: d.steps.map((s) => ({ agent: s.agent, as: s.as ?? "" })),
              body: d.body,
            });
          } else {
            const d = def as Agent;
            setA({
              name: d.name,
              description: d.description,
              model: d.model ?? "",
              tools: d.tools ?? [],
              inputs: d.inputs,
              outputs: d.outputs,
              body: d.body,
            });
          }
        })
        .catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false));
    } else {
      setSlugValue("");
      setA(defaultAgent());
      setP(defaultPipeline(agentOptions));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const targetSlug = mode === "create" ? slugValue.trim() : (slug ?? "");
  const slugOk = mode === "edit" || SLUG_RE.test(targetSlug);
  const valid =
    kind === "pipeline"
      ? p.description.trim() !== "" &&
        p.steps.length > 0 &&
        p.steps.every((s) => s.agent)
      : a.description.trim() !== "" && a.body.trim() !== "";
  const canSave = !saving && !loading && slugOk && valid;

  function save() {
    const fields =
      kind === "pipeline"
        ? {
            name: p.name,
            description: p.description,
            inputs: p.inputs,
            steps: p.steps.map((s) => ({ agent: s.agent, as: s.as.trim() || null })),
            body: p.body,
          }
        : {
            name: a.name,
            description: a.description,
            model: a.model || null,
            tools: a.tools.length ? a.tools : null,
            inputs: a.inputs,
            outputs: a.outputs,
            body: a.body,
          };
    startSave(async () => {
      try {
        await saveAgentDefAction(kind, targetSlug, fields, mode === "create");
        setOpen(false);
        toast.success(`${kind} "${targetSlug}" saved`);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    });
  }

  const modelOptions =
    a.model && !KNOWN_MODELS.includes(a.model)
      ? [...KNOWN_MODELS, a.model]
      : KNOWN_MODELS;

  return (
    <>
      {mode === "create" ? (
        <Button
          variant="outline"
          size="sm"
          className={`h-7 gap-1.5 px-2 text-xs ${className ?? ""}`}
          onClick={() => setOpen(true)}
        >
          <Plus className="size-3" />
          New {kind}
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon-sm"
          className={`size-7 text-muted-foreground ${className ?? ""}`}
          title={`Edit ${kind}`}
          onClick={() => setOpen(true)}
        >
          <Pencil className="size-3.5" />
        </Button>
      )}

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
          <SheetHeader className="border-b">
            <SheetTitle className="font-mono">
              {mode === "create" ? `New ${kind}` : `Edit ${kind}: ${slug}`}
            </SheetTitle>
            <SheetDescription>
              Fill in the fields — the file is generated for you.
            </SheetDescription>
          </SheetHeader>

          {loading ? (
            <div className="flex-1 p-4 text-sm text-muted-foreground">Loading…</div>
          ) : (
            <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
              {mode === "create" && (
                <Field label="slug (filename)" hint="lowercase, digits, hyphens">
                  <Input
                    value={slugValue}
                    onChange={(e) => setSlugValue(e.target.value)}
                    placeholder={kind === "pipeline" ? "my-pipeline" : "my-agent"}
                    className="font-mono text-sm"
                    autoFocus
                  />
                  {slugValue.trim() && !SLUG_RE.test(slugValue.trim()) && (
                    <p className="text-xs text-red-600">
                      Use kebab-case: a-z, 0-9, hyphens.
                    </p>
                  )}
                </Field>
              )}

              {kind === "agent" ? (
                <>
                  <Field label="name">
                    <Input
                      value={a.name}
                      onChange={(e) => setA({ ...a, name: e.target.value })}
                      placeholder={targetSlug || "agent name"}
                      className="text-sm"
                    />
                  </Field>
                  <Field label="description" hint="one line — the recall hook">
                    <Input
                      value={a.description}
                      onChange={(e) =>
                        setA({ ...a, description: e.target.value })
                      }
                      placeholder="What this agent does"
                      className="text-sm"
                    />
                  </Field>
                  <Field label="model">
                    <select
                      value={a.model}
                      onChange={(e) => setA({ ...a, model: e.target.value })}
                      className={SELECT_CLS}
                    >
                      <option value="">Inherit caller&rsquo;s model</option>
                      {modelOptions.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <TokenField
                    label="tools"
                    hint="empty = read-only default (Read, Grep, Glob, WebSearch, WebFetch)"
                    tokens={a.tools}
                    onChange={(t) => setA({ ...a, tools: t })}
                    suggestions={TOOL_SUGGESTIONS}
                  />
                  <TokenField
                    label="inputs"
                    hint="values the agent reads (used as {{name}} in the prompt)"
                    tokens={a.inputs}
                    onChange={(t) => setA({ ...a, inputs: t })}
                  />
                  <TokenField
                    label="outputs"
                    hint="values the agent returns"
                    tokens={a.outputs}
                    onChange={(t) => setA({ ...a, outputs: t })}
                  />
                  <Field label="system prompt" hint="use {{input}} to interpolate">
                    <Textarea
                      value={a.body}
                      onChange={(e) => setA({ ...a, body: e.target.value })}
                      spellCheck={false}
                      className="min-h-48 font-mono text-xs leading-relaxed"
                    />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="name">
                    <Input
                      value={p.name}
                      onChange={(e) => setP({ ...p, name: e.target.value })}
                      placeholder={targetSlug || "pipeline name"}
                      className="text-sm"
                    />
                  </Field>
                  <Field label="description" hint="one line">
                    <Input
                      value={p.description}
                      onChange={(e) =>
                        setP({ ...p, description: e.target.value })
                      }
                      placeholder="What this pipeline does"
                      className="text-sm"
                    />
                  </Field>
                  <TokenField
                    label="inputs"
                    tokens={p.inputs}
                    onChange={(t) => setP({ ...p, inputs: t })}
                  />
                  <StepsField
                    steps={p.steps}
                    onChange={(s) => setP({ ...p, steps: s })}
                    agentOptions={agentOptions}
                  />
                  <Field label="description body" hint="a sentence describing the flow">
                    <Textarea
                      value={p.body}
                      onChange={(e) => setP({ ...p, body: e.target.value })}
                      spellCheck={false}
                      className="min-h-24 font-mono text-xs leading-relaxed"
                    />
                  </Field>
                </>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 border-t p-4">
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={!canSave}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Chip list + add-input (+ optional suggestion toggles) for a list of tokens. */
function TokenField({
  label,
  hint,
  tokens,
  onChange,
  suggestions,
}: {
  label: string;
  hint?: string;
  tokens: string[];
  onChange: (tokens: string[]) => void;
  suggestions?: string[];
}) {
  const [draft, setDraft] = useState("");
  const clean = (t: string) => t.replace(/[^A-Za-z0-9_-]/g, "");
  const add = (raw: string) => {
    const t = clean(raw);
    if (t && !tokens.includes(t)) onChange([...tokens, t]);
    setDraft("");
  };
  const remove = (t: string) => onChange(tokens.filter((x) => x !== t));

  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      <div className="flex flex-wrap items-center gap-1 rounded-md border p-1.5">
        {tokens.map((t) => (
          <span
            key={t}
            className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
          >
            {t}
            <button
              type="button"
              onClick={() => remove(t)}
              aria-label={`Remove ${t}`}
              className="opacity-60 hover:opacity-100"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add(draft);
            } else if (e.key === "Backspace" && !draft && tokens.length) {
              remove(tokens[tokens.length - 1]);
            }
          }}
          onBlur={() => draft && add(draft)}
          placeholder="add…"
          className="min-w-16 flex-1 bg-transparent px-1 font-mono text-xs outline-none"
        />
      </div>
      {suggestions && (
        <div className="flex flex-wrap gap-1">
          {suggestions.map((s) => {
            const on = tokens.includes(s);
            return (
              <button
                key={s}
                type="button"
                onClick={() => (on ? remove(s) : onChange([...tokens, s]))}
                className={`rounded border px-1.5 py-0.5 font-mono text-xs transition-colors ${
                  on
                    ? "border-transparent bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                }`}
              >
                {s}
              </button>
            );
          })}
        </div>
      )}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Ordered pipeline steps: each picks a real agent + an optional `as` label. */
function StepsField({
  steps,
  onChange,
  agentOptions,
}: {
  steps: { agent: string; as: string }[];
  onChange: (steps: { agent: string; as: string }[]) => void;
  agentOptions: string[];
}) {
  const set = (i: number, patch: Partial<{ agent: string; as: string }>) =>
    onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const copy = [...steps];
    [copy[i], copy[j]] = [copy[j], copy[i]];
    onChange(copy);
  };
  const remove = (i: number) => onChange(steps.filter((_, j) => j !== i));
  const add = () => onChange([...steps, { agent: agentOptions[0] ?? "", as: "" }]);

  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">steps</Label>
      <div className="space-y-1.5">
        {steps.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="w-4 shrink-0 text-xs text-muted-foreground tabular-nums">
              {i + 1}
            </span>
            <select
              value={s.agent}
              onChange={(e) => set(i, { agent: e.target.value })}
              className={`${SELECT_CLS} min-w-0 flex-1`}
            >
              <option value="" disabled>
                choose agent…
              </option>
              {agentOptions.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
              {s.agent && !agentOptions.includes(s.agent) && (
                <option value={s.agent}>{s.agent} (missing)</option>
              )}
            </select>
            <Input
              value={s.as}
              onChange={(e) => set(i, { as: e.target.value.replace(/[^A-Za-z0-9_-]/g, "") })}
              placeholder="as (optional)"
              className="h-8 w-28 shrink-0 font-mono text-xs"
            />
            <button
              type="button"
              onClick={() => move(i, -1)}
              disabled={i === 0}
              aria-label="Move up"
              className="text-muted-foreground hover:text-foreground disabled:opacity-30"
            >
              <ChevronUp className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => move(i, 1)}
              disabled={i === steps.length - 1}
              aria-label="Move down"
              className="text-muted-foreground hover:text-foreground disabled:opacity-30"
            >
              <ChevronDown className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => remove(i)}
              disabled={steps.length === 1}
              aria-label="Remove step"
              className="text-muted-foreground hover:text-red-600 disabled:opacity-30"
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs"
        onClick={add}
      >
        <Plus className="size-3" />
        Add step
      </Button>
    </div>
  );
}

/** Delete one agent/pipeline file (with a confirm), then refresh the page. */
export function DeleteAgentButton({
  kind,
  slug,
  name,
}: {
  kind: Kind;
  slug: string;
  name: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function del() {
    if (!confirm(`Delete ${kind} "${name}"? This removes ${slug}.md.`)) return;
    start(async () => {
      try {
        await deleteAgentSourceAction(kind, slug);
        toast.success(`${kind} "${name}" deleted`);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="size-7 text-muted-foreground hover:text-red-600"
      title={`Delete ${kind}`}
      disabled={pending}
      onClick={del}
    >
      <Trash2 className="size-3.5" />
    </Button>
  );
}
