// The session-start eval runner. Run from the repo root:
//
//   node --experimental-strip-types packages/mcp/src/session-start-eval-cli.ts <command>
//
//   check                       validate scenario.json and print what a run would send
//   run --model <openrouter id> one first-turn episode per task; writes a result file
//       [--out <file>] [--limit <n>]
//
// The instructions the model sees are INSTRUCTION_BLOCK from services/cli/src/install.ts,
// the block `cf install` writes, so the eval measures the text users get.
//
// `run` needs OPENROUTER_API_KEY and spends real money: it is an operator step. Run it
// once per model and commit the result files; /benchmarks shows the newest per model.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { INSTRUCTION_BLOCK } from "./instruction-block.ts";
import { benchmarksRoot } from "../../core/src/golden-set.ts";
import { CompetitorFileSchema, evalTools, selectionRoot } from "./selection-eval.ts";
import { operatorModelKey, type FetchLike } from "./selection-eval-cli.ts";
import {
  buildSessionResult,
  runSessionEpisode,
  SessionScenarioSchema,
  sessionStartRoot,
  sessionSystemPrompt,
  type SessionModelCall,
  type SessionOutcome,
  type SessionToolCall,
} from "./session-start-eval.ts";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/** The real model call, through OpenRouter. Every tool call of the first turn, in order. */
export function openRouterCall(apiKey: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): SessionModelCall {
  return async ({ model, system, user, tools }) => {
    const res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "HTTP-Referer": "https://contextfile.ai", "X-Title": "ContextFile session-start eval" },
      body: JSON.stringify({
        model,
        temperature: 0,
        tool_choice: "auto",
        tools,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) {
      const why = await res.json().then((b) => (b as { error?: { message?: unknown } }).error?.message, () => undefined);
      throw new Error(`HTTP ${res.status}${typeof why === "string" ? `: ${why.slice(0, 300)}` : ""}`);
    }
    const body = (await res.json()) as { choices?: { message?: { tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[] };
    const out: SessionToolCall[] = [];
    for (const c of body.choices?.[0]?.message?.tool_calls ?? []) {
      if (!c.function?.name) continue;
      let args: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(c.function.arguments ?? "{}") as unknown;
        args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
      } catch {
        args = null;
      }
      out.push({ name: c.function.name, arguments: args });
    }
    return out;
  };
}

export function loadSessionInputs(selection: string = selectionRoot(benchmarksRoot()), instructions: string = INSTRUCTION_BLOCK) {
  const scenarioText = readFileSync(join(sessionStartRoot(selection), "scenario.json"), "utf8");
  const competitorsText = readFileSync(join(selection, "competitors.json"), "utf8");
  const scenario = SessionScenarioSchema.parse(JSON.parse(scenarioText));
  const ids = new Set<string>();
  for (const t of scenario.tasks) {
    if (ids.has(t.id)) throw new Error(`[session-start-eval] duplicate task id ${t.id}`);
    ids.add(t.id);
  }
  const competitors = CompetitorFileSchema.parse(JSON.parse(competitorsText));
  return { scenarioText, scenario, competitorsText, competitors, instructions, system: sessionSystemPrompt(scenario, instructions), tools: evalTools(competitors) };
}

/** Runs every task (or the first `limit`) through `call` and builds the result. */
export async function runSessionEval(i: { model: string; call: SessionModelCall; inputs: ReturnType<typeof loadSessionInputs>; limit?: number; ranAt?: Date; log?: (s: string) => void }) {
  const outcomes: SessionOutcome[] = [];
  for (const task of i.inputs.scenario.tasks.slice(0, i.limit ?? i.inputs.scenario.tasks.length)) {
    const o = await runSessionEpisode({ model: i.model, system: i.inputs.system, task, tools: i.inputs.tools, call: i.call });
    outcomes.push(o);
    i.log?.(`[session-start-eval] ${task.id}: ${o.calls.join(", ") || "no tool"}${o.error ? ` (error: ${o.error})` : ""}`);
  }
  return buildSessionResult({
    model: i.model,
    ranAt: i.ranAt ?? new Date(),
    scenarioText: i.inputs.scenarioText,
    instructions: i.inputs.instructions,
    competitorsText: i.inputs.competitorsText,
    competitors: i.inputs.competitors.servers.map((s) => s.server),
    outcomes,
  });
}

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { model: { type: "string" }, out: { type: "string" }, limit: { type: "string" } } });
  const selection = selectionRoot(benchmarksRoot());
  const inputs = loadSessionInputs(selection);
  const log = (s: string) => process.stdout.write(s + "\n");
  if (positionals[0] === "check") {
    log(`[session-start-eval] ${inputs.scenario.tasks.length} first tasks, ${inputs.tools.length} tools (${inputs.competitors.servers.length} competing servers), instructions block of ${inputs.instructions.length} characters from cf install.`);
    return 0;
  }
  if (positionals[0] !== "run" || !values.model) {
    log("usage: session-start-eval-cli.ts check | run --model <openrouter model id> [--out <file>] [--limit <n>]");
    return 1;
  }
  const apiKey = operatorModelKey();
  if (!apiKey) {
    log("[session-start-eval] OPENROUTER_API_KEY is not set; the run calls real models and is an operator step.");
    return 1;
  }
  const result = await runSessionEval({ model: values.model, call: openRouterCall(apiKey), inputs, limit: values.limit ? Number(values.limit) : undefined, log });
  const out = values.out ?? join(sessionStartRoot(selection), "results", `${result.body.ranAt.slice(0, 10)}-${values.model.replace(/[^a-z0-9.-]+/gi, "_")}.json`);
  mkdirSync(join(out, ".."), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  const m = result.body.metrics;
  log(`[session-start-eval] context_load first ${m.loadFirst}/${m.tasks}, before other work ${m.loadBeforeWork}/${m.tasks}, errors ${m.errors}. Wrote ${out}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e) => {
      process.stdout.write(`[session-start-eval] ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    }
  );
}
