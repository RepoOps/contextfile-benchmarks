// R9 / versioned shared context: the session-start eval. `cf install` writes a block
// into CLAUDE.md or AGENTS.md that says "when a session starts, call context_load".
// This measures how often a model does that, per model.
//
// One episode is the first turn of a session: the system prompt carries the
// instructions block exactly as `cf install` writes it, the model sees every tool
// (ContextFile's plus the competing servers', named <server>__<tool>) and the user's
// first task. We record every tool call the model makes in that first turn, before it
// has seen any tool result, and score:
//   - load first: the first call is contextfile__context_load
//   - load before work: context_load is among the first turn's calls (a parallel call
//     made before any other work has come back)
//
// The model call is injected (SessionModelCall), so tests use a fake model and spend
// nothing. Data lives in benchmarks/tool-selection/session-start/ (scenario.json and
// results/). The runner is session-start-eval-cli.ts.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CONTEXTFILE_SERVER, digestOf, type EvalTool } from "./selection-eval.ts";

export const SESSION_START_HARNESS_VERSION = "session-start-eval/1";
export const CONTEXT_LOAD_CALL = `${CONTEXTFILE_SERVER}__context_load`;

export const SessionScenarioSchema = z.object({
  version: z.string(),
  system: z.string().min(10),
  tasks: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]+$/), prompt: z.string().min(10) })).min(1),
});
export type SessionScenario = z.infer<typeof SessionScenarioSchema>;
export type SessionTask = SessionScenario["tasks"][number];

/** The host's system prompt for the first turn: the scenario's prompt plus the installed instructions file. */
export function sessionSystemPrompt(scenario: SessionScenario, instructions: string): string {
  return `${scenario.system}\n\nContents of CLAUDE.md (project instructions):\n\n${instructions}`;
}

export interface SessionToolCall {
  name: string;
  arguments: Record<string, unknown> | null;
}

/** One model call: returns the tool calls of the model's first turn, in order (empty for none). */
export type SessionModelCall = (req: { model: string; system: string; user: string; tools: EvalTool[] }) => Promise<SessionToolCall[]>;

export interface SessionOutcome {
  task: string;
  /** Full tool names (<server>__<tool>) called in the first turn, in order. */
  calls: string[];
  /** A model call that failed; the task counts as not loading context and is reported. */
  error?: string;
}

export async function runSessionEpisode(i: { model: string; system: string; task: SessionTask; tools: EvalTool[]; call: SessionModelCall }): Promise<SessionOutcome> {
  try {
    const calls = await i.call({ model: i.model, system: i.system, user: i.task.prompt, tools: i.tools });
    return { task: i.task.id, calls: calls.map((c) => c.name) };
  } catch (e) {
    return { task: i.task.id, calls: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export const loadsFirst = (o: SessionOutcome) => o.calls[0] === CONTEXT_LOAD_CALL;
export const loadsBeforeWork = (o: SessionOutcome) => o.calls.includes(CONTEXT_LOAD_CALL);

export interface SessionMetrics {
  tasks: number;
  loadFirst: number;
  /** loadFirst / tasks, or null with no task run. */
  loadFirstRate: number | null;
  loadBeforeWork: number;
  loadBeforeWorkRate: number | null;
  /** Tasks where the model made no tool call at all. */
  noCall: number;
  errors: number;
}

export function scoreSession(outcomes: SessionOutcome[]): SessionMetrics {
  const rate = (a: number) => (outcomes.length === 0 ? null : a / outcomes.length);
  const loadFirst = outcomes.filter(loadsFirst).length;
  const loadBeforeWork = outcomes.filter(loadsBeforeWork).length;
  return {
    tasks: outcomes.length,
    loadFirst,
    loadFirstRate: rate(loadFirst),
    loadBeforeWork,
    loadBeforeWorkRate: rate(loadBeforeWork),
    noCall: outcomes.filter((o) => !o.error && o.calls.length === 0).length,
    errors: outcomes.filter((o) => o.error).length,
  };
}

export const SessionResultBodySchema = z.object({
  kind: z.literal("contextfile.session-start/v1"),
  harnessVersion: z.string(),
  model: z.string(),
  ranAt: z.string(),
  scenarioDigest: z.string(),
  instructionsDigest: z.string(),
  competitorsDigest: z.string(),
  competitors: z.array(z.string()),
  metrics: z.object({
    tasks: z.number().int(),
    loadFirst: z.number().int(),
    loadFirstRate: z.number().nullable(),
    loadBeforeWork: z.number().int(),
    loadBeforeWorkRate: z.number().nullable(),
    noCall: z.number().int(),
    errors: z.number().int(),
  }),
  outcomes: z.array(z.object({ task: z.string(), calls: z.array(z.string()), error: z.string().optional() })),
});
export type SessionResultBody = z.infer<typeof SessionResultBodySchema>;
export const SessionResultSchema = z.object({ digest: z.string(), body: SessionResultBodySchema });
export type SessionResult = z.infer<typeof SessionResultSchema>;

const sha = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");

export function buildSessionResult(i: { model: string; ranAt: Date; scenarioText: string; instructions: string; competitorsText: string; competitors: string[]; outcomes: SessionOutcome[] }): SessionResult {
  const body: SessionResultBody = {
    kind: "contextfile.session-start/v1",
    harnessVersion: SESSION_START_HARNESS_VERSION,
    model: i.model,
    ranAt: i.ranAt.toISOString(),
    scenarioDigest: sha(i.scenarioText),
    instructionsDigest: sha(i.instructions),
    competitorsDigest: sha(i.competitorsText),
    competitors: i.competitors,
    metrics: scoreSession(i.outcomes),
    outcomes: i.outcomes,
  };
  return { digest: digestOf(body), body };
}

/** benchmarks/tool-selection/session-start, given the tool-selection root. */
export function sessionStartRoot(selectionRoot: string): string {
  return join(selectionRoot, "session-start");
}

/**
 * Every result file whose digest matches its body, newest first. A file that does not
 * parse or whose digest does not match is counted, never shown.
 */
export function loadSessionResults(root: string): { results: (SessionResult & { file: string })[]; invalid: number } {
  const dir = join(root, "results");
  if (!existsSync(dir)) return { results: [], invalid: 0 };
  const results: (SessionResult & { file: string })[] = [];
  let invalid = 0;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    try {
      const r = SessionResultSchema.parse(JSON.parse(readFileSync(join(dir, f), "utf8")));
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

/** The newest result per model. */
export function latestSessionPerModel(results: SessionResult[]): SessionResult[] {
  const seen = new Set<string>();
  return results.filter((r) => (seen.has(r.body.model) ? false : (seen.add(r.body.model), true)));
}
