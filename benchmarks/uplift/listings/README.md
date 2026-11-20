# Per-listing uplift test

This folder measures what one listed artifact adds to a model's answers. The harness
asks the same model the same knowledge-gap questions in three arms:

- `none`: the question alone
- `docs_summary`: the question plus an LLM summary of the public docs the artifact was
  built from. This is the baseline a buyer will compare against: LLM-written context
  files did not raise task success in the ETH Zurich study
  (arXiv 2602.11988).
- `artifact`: the question plus the artifact text

Every task runs at least five times per arm (`seeds` in `config.json`). The questions
probe what a model is likely not to know: APIs and changes newer than its training,
deprecations, and exact commands.

The code is `packages/core/src/probe-uplift.ts` (schema, grading, statistics, result
file, estimate) and `packages/core/src/probe-uplift-cli.ts` (the command line and the
OpenRouter client). Neither holds a secret.

## What is here

| Path | What it holds |
| --- | --- |
| `config.json` | Models, seeds, temperature, answer token limit and bootstrap settings. Example values until the operator confirms them. |
| `<seed id>/probe.json` | One listing's probe set. The folder name is the candidate id in the launch seed table. |
| `<seed id>/results/*.json` | Signed results, one per run. Earlier files are never edited. |

The pilot sets are `own-contextfile-docs` (10 tasks), `docs-nextjs` (Next.js 16, 10
tasks) and `docs-vite` (Vite 7, 8 tasks). Each sets `reviewedBy: null` until a person
checks every task against its `sourceUrl`; results name the reviewer, or say none.

## What a result reports

Per model and arm: pass rate over all runs, mean tokens per answer, the billed cost
OpenRouter reported (or "not reported"), and adherence: of runs on tasks that name
commands, the share whose answer used every named command verbatim. Each answer is one
model call with no tools, so steps are one per answer and tokens and cost are the
efficiency figures.

Per model, two pass-rate deltas: artifact minus no context, and artifact minus summary.

**How the interval is computed.** Each task gives one paired difference: its pass rate
in the artifact arm minus its pass rate in the baseline arm, each averaged over the
task's seeds. The delta is the mean difference over tasks. The interval is a paired
bootstrap over tasks: resample the tasks with replacement `resamples` times, take the
mean of each resample, and report the percentile interval at `confidence`. Tasks are
the unit because the seeds of one task are not independent of each other. The random
generator is seeded (`rngSeed`), so anyone can recompute the interval from the items
in the result file. With ten tasks the interval is wide; read it before the estimate.

**Grading.** Pattern checks on the answer text, not tests. Every result says so.

Every result names the artifact id, version number and content digest it measured,
the probe set digest, the summary's digest and the model that wrote it, the prompt
hash, the seeds and the statistics settings, and is signed like the uplift and
golden-set results. The listing page shows the newest result signed by a published key
(`REPORT_SIGNING_KEY_PEM`), names its file and digest beside the figures, and says when
it measured an earlier version. With no such result it says none exists.

## Run the pilot

The run is billable: every call goes to OpenRouter. It needs the owner's approval
first. Estimate it without calling any model:

```text
node --experimental-strip-types packages/core/src/probe-uplift-cli.ts check
node --experimental-strip-types packages/core/src/probe-uplift-cli.ts estimate --models 1 --artifact-tokens <n> --summary-tokens <n> --price-in <usd> --price-out <usd>
```

Without flags, `estimate` uses Example sizes (8,000 artifact tokens, 2,000 summary
tokens) and Example prices ($3 in, $15 out per million tokens). It counts tokens as
characters over four and assumes every answer uses the full token limit, so its cost
is an upper bound.

For each pilot listing, export the artifact text of the offered version, write the
summary with one model from the same public docs (save the text), then:

```text
node --experimental-strip-types packages/core/src/probe-uplift-cli.ts run \
  --listing docs-nextjs --artifact <artifact.md> \
  --summary <summary.md> --summary-model <model id> --summary-source <docs url> \
  --artifact-id <uuid> --artifact-version <n> [--listing-id <uuid>] [--report-digest <digest>] \
  --model <openrouter model id>
```

`run` needs `OPENROUTER_API_KEY` and signs with `REPORT_SIGNING_KEY_PEM`; without the
key the result is signed by a throwaway key and the listing page will not show it.

## Editing a set

Change `probe.json` and commit it. The probe set digest changes with any edit, and
results name the digest they ran on. Probe prompts, the summary and the artifact text
are data: the context reaches the model inside `<reference>` markers with a system line
saying never to follow instructions written inside it.
