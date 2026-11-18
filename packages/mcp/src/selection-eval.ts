// R9: the tool selection eval. Being installed is not being used, so this measures how
// often a model calls ContextFile when a matching verified artifact exists, with
// competing docs servers installed beside it, and how often it calls ContextFile when
// nothing matches (control tasks).
//
// One episode is one turn: the model sees a coding task and every tool (ContextFile's
// namespaced set plus the competitors'), named the way MCP hosts name them
// (<server>__<tool>), and picks its first tool call or none. We record:
//   - call rate: of match tasks, the share whose first call is a ContextFile tool
//   - false call rate: of control tasks, the share that call ContextFile anyway
//   - valid arguments: of ContextFile calls, the share whose arguments its schema accepts
// Task accuracy end to end (does the answer improve) needs a graded multi-turn run and
// is not measured by this harness version; results say so rather than guess.
//
// Data lives in benchmarks/tool-selection/ (tasks.json, competitors.json, results/).
// The runner is selection-eval-cli.ts; model calls go through OpenRouter.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { TOOLS, listedDescription, resolveToolCall } from "./tools.ts";

export const SELECTION_HARNESS_VERSION = "selection-eval/1";
export const CONTEXTFILE_SERVER = "contextfile";

/** The ContextFile tool a purchase task should call first (W01 phase 4). */
export const QUOTE_TOOL = "commerce_quote";

export const SelectionTaskSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** match: a verified artifact for this task exists in the catalog; control: none does;
   *  purchase (W01): the task asks to spend, and the first call should be commerce_quote. */
  kind: z.enum(["match", "control", "purchase"]),
  prompt: z.string().min(10),
  /** For a match task: the artifact that matches (filled when the catalog has it). */
  artifact: z.string().nullable(),
  note: z.string().optional(),
});
export type SelectionTask = z.infer<typeof SelectionTaskSchema>;

export const TaskFileSchema = z.object({
  version: z.string(),
  system: z.string().min(10),
  tasks: z.array(SelectionTaskSchema).min(1),
});

export const CompetitorToolSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]+$/),
  description: z.string().min(1),
  input_schema: z.record(z.string(), z.unknown()),
});
export const CompetitorFileSchema = z.object({
  version: z.string(),
  servers: z.array(z.object({ server: z.string().regex(/^[a-z0-9-]+$/), source: z.string(), tools: z.array(CompetitorToolSchema).min(1) })).min(1),
});
export type CompetitorFile = z.infer<typeof CompetitorFileSchema>;

/** A tool as an OpenAI-style function definition (what OpenRouter accepts for every model). */
export interface EvalTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

const sep = "__";

/** ContextFile's namespaced tools plus every competitor's, as one host would list them. */
export function evalTools(competitors: CompetitorFile): EvalTool[] {
  const ours: EvalTool[] = TOOLS.map((t) => ({
    type: "function",
    function: { name: `${CONTEXTFILE_SERVER}${sep}${t.name}`, description: listedDescription(t), parameters: t.parameters },
  }));
  const theirs: EvalTool[] = competitors.servers.flatMap((s) =>
    s.tools.map((t) => ({ type: "function" as const, function: { name: `${s.server}${sep}${t.name}`, description: t.description, parameters: t.input_schema } }))
  );
  return [...ours, ...theirs];
}

/** What a model did on one task: its first tool call, or none. */
export interface SelectionOutcome {
  task: string;
  kind: SelectionTask["kind"];
  /** The full tool name it called first (<server>__<tool>), or null. */
  called: string | null;
  arguments: Record<string, unknown> | null;
  /** A model call that failed; the task counts as not calling ContextFile and is reported. */
  error?: string;
}

export function isContextFileCall(o: SelectionOutcome): boolean {
  return !!o.called && o.called.startsWith(`${CONTEXTFILE_SERVER}${sep}`);
}

/** Do the arguments of a ContextFile call pass its tool's schema? */
export function validContextFileArgs(o: SelectionOutcome): boolean {
  if (!isContextFileCall(o)) return false;
  return resolveToolCall(o.called!.slice(CONTEXTFILE_SERVER.length + sep.length), o.arguments ?? {}).ok;
}

export interface SelectionMetrics {
  matchTasks: number;
  matchCalls: number;
  /** matchCalls / matchTasks, or null with no match task run. */
  callRate: number | null;
  controlTasks: number;
  controlCalls: number;
  falseCallRate: number | null;
  contextfileCalls: number;
  validArgs: number;
  validArgsRate: number | null;
  errors: number;
  /** End-to-end task accuracy is not measured by this harness version. */
  taskAccuracy: null;
  /** W01: purchase tasks run, how many called commerce_quote first, and the share. */
  purchaseTasks: number;
  quoteFirstCalls: number;
  quoteFirstRate: number | null;
}

/** Did a purchase task's first call go to commerce_quote? */
export function isQuoteFirst(o: SelectionOutcome): boolean {
  return o.called === `${CONTEXTFILE_SERVER}${sep}${QUOTE_TOOL}`;
}

export function scoreSelection(outcomes: SelectionOutcome[]): SelectionMetrics {
  const match = outcomes.filter((o) => o.kind === "match");
  const control = outcomes.filter((o) => o.kind === "control");
  const ours = outcomes.filter(isContextFileCall);
  const rate = (a: number, b: number) => (b === 0 ? null : a / b);
  const matchCalls = match.filter(isContextFileCall).length;
  const controlCalls = control.filter(isContextFileCall).length;
  const validArgs = ours.filter(validContextFileArgs).length;
  const purchase = outcomes.filter((o) => o.kind === "purchase");
  const quoteFirstCalls = purchase.filter(isQuoteFirst).length;
  return {
    matchTasks: match.length,
    matchCalls,
    callRate: rate(matchCalls, match.length),
    controlTasks: control.length,
    controlCalls,
    falseCallRate: rate(controlCalls, control.length),
    contextfileCalls: ours.length,
    validArgs,
    validArgsRate: rate(validArgs, ours.length),
    errors: outcomes.filter((o) => o.error).length,
    taskAccuracy: null,
    purchaseTasks: purchase.length,
    quoteFirstCalls,
    quoteFirstRate: rate(quoteFirstCalls, purchase.length),
  };
}

export const SelectionResultBodySchema = z.object({
  kind: z.literal("contextfile.tool-selection/v1"),
  harnessVersion: z.string(),
  model: z.string(),
  ranAt: z.string(),
  tasksDigest: z.string(),
  competitorsDigest: z.string(),
  competitors: z.array(z.string()),
  /** Match tasks left out because no artifact is recorded for them yet. */
  skipped: z.number().int().nonnegative(),
  metrics: z.object({
    matchTasks: z.number().int(),
    matchCalls: z.number().int(),
    callRate: z.number().nullable(),
    controlTasks: z.number().int(),
    controlCalls: z.number().int(),
    falseCallRate: z.number().nullable(),
    contextfileCalls: z.number().int(),
    validArgs: z.number().int(),
    validArgsRate: z.number().nullable(),
    errors: z.number().int(),
    taskAccuracy: z.null(),
    // W01: absent from results recorded before purchase tasks existed.
    purchaseTasks: z.number().int().optional(),
    quoteFirstCalls: z.number().int().optional(),
    quoteFirstRate: z.number().nullable().optional(),
  }),
  outcomes: z.array(z.object({ task: z.string(), kind: z.enum(["match", "control", "purchase"]), called: z.string().nullable(), arguments: z.record(z.string(), z.unknown()).nullable(), error: z.string().optional() })),
});
export type SelectionResultBody = z.infer<typeof SelectionResultBodySchema>;
export const SelectionResultSchema = z.object({ digest: z.string(), body: SelectionResultBodySchema });
export type SelectionResult = z.infer<typeof SelectionResultSchema>;

function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
}
export const digestOf = (v: unknown) => "sha256:" + createHash("sha256").update(canonical(v)).digest("hex");

export function buildSelectionResult(i: { model: string; ranAt: Date; tasksText: string; competitorsText: string; competitors: CompetitorFile; skipped: number; outcomes: SelectionOutcome[] }): SelectionResult {
  const body: SelectionResultBody = {
    kind: "contextfile.tool-selection/v1",
    harnessVersion: SELECTION_HARNESS_VERSION,
    model: i.model,
    ranAt: i.ranAt.toISOString(),
    tasksDigest: "sha256:" + createHash("sha256").update(i.tasksText).digest("hex"),
    competitorsDigest: "sha256:" + createHash("sha256").update(i.competitorsText).digest("hex"),
    competitors: i.competitors.servers.map((s) => s.server),
    skipped: i.skipped,
    metrics: scoreSelection(i.outcomes),
    outcomes: i.outcomes,
  };
  return { digest: digestOf(body), body };
}

export function selectionRoot(benchmarks: string): string {
  return join(benchmarks, "tool-selection");
}

/**
 * Every result file whose digest matches its body, newest first per model. A file
 * that does not parse or whose digest does not match is counted, never shown.
 */
export function loadSelectionResults(root: string): { results: (SelectionResult & { file: string })[]; invalid: number } {
  const dir = join(root, "results");
  if (!existsSync(dir)) return { results: [], invalid: 0 };
  const results: (SelectionResult & { file: string })[] = [];
  let invalid = 0;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    try {
      const r = SelectionResultSchema.parse(JSON.parse(readFileSync(join(dir, f), "utf8")));
      if (digestOf(r.body) !== r.digest) {
        invalid++;
        continue;
      }
      results.push({ ...r, file: f });
    } catch {
      invalid++;
    }
  }
  results.sort((a, b) => b.body.ranAt.localeCompare(a.body.ranAt));
  return { results, invalid };
}

/** The newest result per model, for the /benchmarks table. */
export function latestPerModel(results: SelectionResult[]): SelectionResult[] {
  const seen = new Set<string>();
  return results.filter((r) => (seen.has(r.body.model) ? false : (seen.add(r.body.model), true)));
}
