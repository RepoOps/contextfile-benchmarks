// The tool selection eval runner (R9). Run from the repo root:
//
//   node --experimental-strip-types packages/mcp/src/selection-eval-cli.ts <command>
//
//   check                       validate tasks.json and competitors.json; print counts
//   run --model <openrouter id> one episode per runnable task; writes a result file
//       [--out <file>] [--limit <n>]
//
// `run` needs OPENROUTER_API_KEY and spends real money: it is an operator step. Run it
// once per model family (a Claude, a GPT and a Gemini model id) and commit the result
// files; /benchmarks shows the newest result per model.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { benchmarksRoot } from "../../core/src/golden-set.ts";
import {
  CompetitorFileSchema,
  TaskFileSchema,
  buildSelectionResult,
  evalTools,
  selectionRoot,
  type CompetitorFile,
  type EvalTool,
  type SelectionOutcome,
  type SelectionTask,
} from "./selection-eval.ts";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** One episode: the task, every tool, and the model's first tool call (or none). */
/** ContextFile's OpenRouter key for the operator eval runs (this file and session-start-eval-cli.ts). */
export function operatorModelKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY;
}

export async function runEpisode(i: { model: string; system: string; task: SelectionTask; tools: EvalTool[]; apiKey: string; fetchImpl?: FetchLike }): Promise<SelectionOutcome> {
  const base = { task: i.task.id, kind: i.task.kind };
  try {
    const res = await (i.fetchImpl ?? (fetch as unknown as FetchLike))(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${i.apiKey}`, "Content-Type": "application/json", "HTTP-Referer": "https://contextfile.ai", "X-Title": "ContextFile selection eval" },
      body: JSON.stringify({
        model: i.model,
        temperature: 0,
        tool_choice: "auto",
        tools: i.tools,
        messages: [
          { role: "system", content: i.system },
          { role: "user", content: i.task.prompt },
        ],
      }),
    });
    if (!res.ok) {
      // The provider's reason, so a rejected request (a schema a model refuses, a bad
      // parameter) can be fixed instead of guessed at.
      const why = await res.json().then((b) => (b as { error?: { message?: unknown } }).error?.message, () => undefined);
      return { ...base, called: null, arguments: null, error: `HTTP ${res.status}${typeof why === "string" ? `: ${why.slice(0, 300)}` : ""}` };
    }
    const body = (await res.json()) as { choices?: { message?: { tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[] };
    const call = body.choices?.[0]?.message?.tool_calls?.[0]?.function;
    if (!call?.name) return { ...base, called: null, arguments: null };
    let args: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(call.arguments ?? "{}") as unknown;
      args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      args = null;
    }
    return { ...base, called: call.name, arguments: args };
  } catch (e) {
    return { ...base, called: null, arguments: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export function loadEvalInputs(root: string) {
  const tasksText = readFileSync(join(root, "tasks.json"), "utf8");
  const competitorsText = readFileSync(join(root, "competitors.json"), "utf8");
  const tasks = TaskFileSchema.parse(JSON.parse(tasksText));
  const competitors: CompetitorFile = CompetitorFileSchema.parse(JSON.parse(competitorsText));
  const ids = new Set<string>();
  for (const t of tasks.tasks) {
    if (ids.has(t.id)) throw new Error(`[selection-eval] duplicate task id ${t.id}`);
    ids.add(t.id);
    if (t.kind !== "match" && t.artifact !== null) throw new Error(`[selection-eval] ${t.kind} task ${t.id} names an artifact`);
  }
  // A match task runs only once the catalog has its artifact; control and purchase
  // tasks always run.
  const runnable = tasks.tasks.filter((t) => t.kind !== "match" || t.artifact !== null);
  return { tasksText, competitorsText, tasks, competitors, runnable, skipped: tasks.tasks.length - runnable.length };
}

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { model: { type: "string" }, out: { type: "string" }, limit: { type: "string" } } });
  const root = selectionRoot(benchmarksRoot());
  const inputs = loadEvalInputs(root);
  const log = (s: string) => process.stdout.write(s + "\n");
  if (positionals[0] === "check") {
    const n = (k: string) => inputs.tasks.tasks.filter((t) => t.kind === k).length;
    log(`[selection-eval] ${n("match")} match tasks (${inputs.skipped} waiting for an artifact), ${n("control")} control tasks, ${n("purchase")} purchase tasks, ${inputs.competitors.servers.length} competing servers, ${evalTools(inputs.competitors).length} tools in all.`);
    return 0;
  }
  if (positionals[0] !== "run" || !values.model) {
    log("usage: selection-eval-cli.ts check | run --model <openrouter model id> [--out <file>] [--limit <n>]");
    return 1;
  }
  const apiKey = operatorModelKey();
  if (!apiKey) {
    log("[selection-eval] OPENROUTER_API_KEY is not set; the run calls real models and is an operator step.");
    return 1;
  }
  const tools = evalTools(inputs.competitors);
  const limit = values.limit ? Number(values.limit) : inputs.runnable.length;
  const outcomes: SelectionOutcome[] = [];
  for (const task of inputs.runnable.slice(0, limit)) {
    const o = await runEpisode({ model: values.model, system: inputs.tasks.system, task, tools, apiKey });
    outcomes.push(o);
    log(`[selection-eval] ${task.id}: ${o.called ?? "no tool"}${o.error ? ` (error: ${o.error})` : ""}`);
  }
  const result = buildSelectionResult({ model: values.model, ranAt: new Date(), tasksText: inputs.tasksText, competitorsText: inputs.competitorsText, competitors: inputs.competitors, skipped: inputs.skipped, outcomes });
  const out = values.out ?? join(root, "results", `${result.body.ranAt.slice(0, 10)}-${values.model.replace(/[^a-z0-9.-]+/gi, "_")}.json`);
  mkdirSync(join(out, ".."), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  const m = result.body.metrics;
  log(`[selection-eval] call rate ${m.matchCalls}/${m.matchTasks}, false calls ${m.controlCalls}/${m.controlTasks}, valid arguments ${m.validArgs}/${m.contextfileCalls}. Wrote ${out}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e) => {
      process.stdout.write(`[selection-eval] ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    }
  );
}
