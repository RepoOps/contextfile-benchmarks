# Tool selection eval

Having ContextFile installed does not mean an agent calls it. This eval measures how
often a model calls ContextFile when a matching verified artifact exists, with other
docs servers installed beside it, and how often it calls ContextFile when nothing
matches.

## What is here

| Path | What it holds |
| --- | --- |
| `tasks.json` | The system prompt and the tasks. `match` tasks have a verified artifact in the catalog (`artifact` names it); `control` tasks have none. |
| `competitors.json` | The competing servers' tool definitions shown beside ContextFile's. Today these are paraphrased fixtures; replace each with the server's live `tools/list` output before a published run. |
| `results/*.json` | One result per run: model, date, harness version, digests of the task and competitor files, the metrics and every outcome. |

The harness is `packages/mcp/src/selection-eval.ts` (task schema, tool set, scoring,
result file) and `packages/mcp/src/selection-eval-cli.ts` (the runner).

## Method

One episode per task: the model gets the system prompt, the task and every tool,
named the way MCP hosts name them (`contextfile__artifacts_search`,
`context7__get-library-docs`), and makes at most one tool call. Temperature is 0.

- **Call rate:** of match tasks, the share whose first call is a ContextFile tool.
- **False call rate:** of control tasks, the share that call ContextFile anyway.
- **Valid arguments:** of ContextFile calls, the share whose arguments the tool's own
  schema accepts.
- End-to-end task accuracy (does the answer get better) needs a graded multi-turn run.
  This harness version does not measure it, and its results record `taskAccuracy: null`.

A match task runs only once `artifact` names a verified artifact in the catalog, so a
result never counts a task ContextFile could not have answered. The result records
how many were skipped.

## Commands

Run from the repo root with Node 22 or later.

```
node --experimental-strip-types packages/mcp/src/selection-eval-cli.ts check
node --experimental-strip-types packages/mcp/src/selection-eval-cli.ts run --model <openrouter model id>
```

`run` calls real models through OpenRouter, needs `OPENROUTER_API_KEY` and costs money,
so the operator runs it, once per model family (a Claude, a GPT and a Gemini model),
and commits the result files. `/benchmarks` shows the newest result per model whose
digest matches its body.

## Session start: does the agent call context_load first?

`cf install` writes a block into CLAUDE.md or AGENTS.md that says to call
`context_load` when a session starts. This scenario measures how often a model does.

| Path | What it holds |
| --- | --- |
| `session-start/scenario.json` | The host system prompt and the first user tasks of a new session. |
| `session-start/results/*.json` | One result per run: model, date, harness version, digests of the scenario, the instructions block and the competitor file, the metrics and every outcome. |

One episode per task: the system prompt carries `INSTRUCTION_BLOCK` from
`services/cli/src/install.ts` (the exact text `cf install` writes), the model gets every
tool from ContextFile and `competitors.json`, and the user message is the first task.
The harness records every tool call of that first turn, before any tool result comes
back. Temperature is 0.

- **context_load first:** the share of tasks whose first tool call is `contextfile__context_load`.
- **Before other work:** the share whose first turn includes `contextfile__context_load`
  anywhere (a parallel call made before any other result came back).

The harness is `packages/mcp/src/session-start-eval.ts` (scenario schema, scoring,
result file) and `packages/mcp/src/session-start-eval-cli.ts` (the runner, with the
model call injected so tests use a fake model).

```
node --experimental-strip-types packages/mcp/src/session-start-eval-cli.ts check
node --experimental-strip-types packages/mcp/src/session-start-eval-cli.ts run --model <openrouter model id>
```

`run` needs `OPENROUTER_API_KEY` and costs money: it is an operator step, run once per
model, after which the operator commits `session-start/results/*.json`. Until a result
file exists, `/benchmarks` says the scenario has not been run and shows no rate.
