# ContextFile uplift scorecard

This folder measures what ContextFile adds to a coding agent. The harness asks the same
model the same version-pinned coding questions twice: once with the ContextFile MCP
server connected (the with arm) and once with no tools (the without arm). It publishes,
per model and arm, four numbers:

- accuracy: of tasks, the share whose answer passed the task's checks
- call rate: of tasks, the share where the model called a ContextFile tool at least
  once (with arm only)
- tokens per answer: mean prompt plus completion tokens per answered task
- misgrounded-citation rate: of `[cf:<id>]` citations in answers, the share not backed
  by a tool result in the same run that names the id and holds the task's evidence

Every result names each model id, the run date, the harness version, the prompt hash
and the task set digest.

## What is here

| Path | What it holds |
| --- | --- |
| `tasks/*.json` | One task per file: the library and exact version, the question, the answer checks, the evidence patterns, the license. |
| `sources/gitchameleon.json` | The GitChameleon 2.0 picks: dataset example id, task id and the checks written for it. |
| `manifest.json` | Set id and version, each task's digest and the set digest. |
| `config.json` | The models to score, the MCP URL, the read-only tools the with arm may call, turn and token limits. |
| `results/*.json` | Signed results, one per run. Earlier files are never edited, so they are the history. |

The code is `packages/core/src/uplift.ts` (schema, digests, grading, citation
grounding, metrics, result file) and `packages/core/src/uplift-cli.ts` (the command
line, the OpenRouter tool-calling loop and the MCP client). Neither holds a secret.

## Task set

The committed set is fourteen tasks. Six (`ut-0001` to `ut-0006`) were written for this
harness and released under CC0-1.0. Each asks for code against one pinned library
version where the API changed (for example `DataFrame.append` is gone in pandas 2,
`ReactDOM.render` gave way to `createRoot` in React 18).

Eight (`ut-0007` to `ut-0014`) are a first subset of GitChameleon 2.0
(https://github.com/mrcabbage972/GitChameleonBenchmark, harness Apache-2.0, dataset MIT),
taken from `dataset/dataset.jsonl` at commit `3a1b6045a6b2a276bd24d715589cb041f8eccb93`.
The owner chose this set on 2026-11-09. `sources/gitchameleon.json` lists each pick: the
dataset `example_id` and the pattern checks a person wrote for it. To rebuild the task
files, download that dataset file and run:

```
node --experimental-strip-types packages/core/src/uplift-cli.ts import-gitchameleon <dataset.jsonl>
node --experimental-strip-types packages/core/src/uplift-cli.ts manifest --write
```

Each such task sets `provenance: "public"` and a `sourceUrl` that names the commit and
example, and the loader refuses any license not in its publishable list.

**Grading.** This harness grades by pattern checks on the answer text, not by running
tests. GitChameleon ships unit tests for each problem; this harness does not run them.
Every result file says so in its `grading` field, and `/benchmarks` shows that label
beside every result.

## Rerun it yourself

Run from the repo root with Node 22 or later.

```
node --experimental-strip-types packages/core/src/uplift-cli.ts check
node --experimental-strip-types packages/core/src/uplift-cli.ts run --model <openrouter model id>
node --experimental-strip-types packages/core/src/uplift-cli.ts compare benchmarks/uplift/results/<published>.json <your result>.json
```

`run` needs two keys in the environment:

- `OPENROUTER_API_KEY`: your own OpenRouter key; the harness calls models through it at
  temperature 0.
- `CONTEXTFILE_UPLIFT_TOKEN`: a ContextFile agent access token (a sandbox token from
  `cf login` works). The with arm uses it to call the read-only tools in `config.json`;
  mutating tools are never offered.

Pass `--model` once per model, or list models in `config.json`. `--limit <n>` runs the
first n tasks (a partial run is not comparable to a full one). Your result is signed by
a throwaway key unless `REPORT_SIGNING_KEY_PEM` is set; that is fine for `compare`.
`compare` passes when the task set and prompt match and each model's accuracy in each
arm is within `uplift_rerun_tolerance` (`config/constants.md`, an Example value
until reruns measure it).

## Schedule

The Railway `cron` service checks every night. When the newest published result is
older than `uplift_cadence_days` (Example: 30), it runs the harness and opens a draft
pull request that adds the new result file; a person merges it. `/benchmarks` marks the
scorecard stale when the newest result is older than the cadence. Check by hand with:

```
node --experimental-strip-types packages/core/src/uplift-cli.ts due
```

## Editing the set

Change or add a task file, run `manifest --write`, and commit both. A test fails the
build when the manifest is stale, a digest does not match, or a license does not permit
publication. Task prompts reach the model only as the question; tool results are only
searched for ids and evidence patterns.
