# ContextFile golden set and accuracy harness

This folder measures the ContextFile verifier's judge against labeled claims and
publishes precision, recall and the misgrounded-citation rate. It is built to be
copied to a public repo so anyone can rerun it.

## What is here

| Path | What it holds |
| --- | --- |
| `golden-set/works/*.json` | One labeled work per file: its source passages and its claims, each with an expected verdict and its labels. |
| `golden-set/manifest.json` | Set id and version, the target size (220 works), the stage (`pilot` until the set reaches its target), each work's digest and the set digest. |
| `results/*.json` | Signed results, one per run. |
| `judge-gate.json` | The judge allowed to stand without a result (the one live before the first run). |
| `judge-prompt.json` | The live judge prompt: its version, its hash and the exact text the hash covers. Generated from `packages/core/src/judge.ts`; also served at https://contextfile.ai/benchmarks/judge-prompt.json. |
| `publication.json` | The public harness repo URL, once published. |
| `uplift/` | The uplift scorecard: the same model with and without ContextFile on version-pinned coding tasks. See `uplift/README.md`. |

The harness code is `packages/core/src/golden-set.ts` (schema, digests, metrics,
result file, gate; no secret) and `packages/core/src/golden-cli.ts` (the command line
and the judge backend). The judge prompt is in `packages/core/src/judge.ts`.

## The judge prompt

The live judge prompt is public (owner decision 2026-11-11). `judge-prompt.json` holds
its version, its sha256 hash and its text; every result and report pins the same
version and hash, so you can check that a rerun used the prompt we did. The file is
generated, never edited by hand:

```
node --experimental-strip-types packages/core/src/golden-cli.ts judge-prompt --write
```

`judge-prompt` without `--write` fails when the file differs from `judge.ts`, and a
test fails the build on the same drift. When a new judge version ships, the old text
moves to the retired-prompt archive on /docs/methodology.

## Verdicts

- `supported`: the cited passage states the claim.
- `wrong`: the claim is false; the cited passage contradicts it.
- `misgrounded`: the claim may be true, but the cited passage does not support it.

## Metrics

A claim passes when the judge's entailment score is at or above
`golden_pass_threshold`. A failed judge call counts as not passed and is reported.

- precision: of claims the judge passed, the share labeled supported
- recall: of claims labeled supported, the share the judge passed
- misgrounded rate: of claims labeled misgrounded, the share the judge passed
- false-claim pass rate: of claims labeled wrong, the share the judge passed

The thresholds the judge gate uses, the pass threshold and the rerun tolerance are
rows in `config/constants.md` (`golden_*`). All are Example values until the
operator confirms them; the tolerance stays Example until reruns measure it.

## Commands

Run from the repo root with Node 22 or later.

```
node --experimental-strip-types packages/core/src/golden-cli.ts check
node --experimental-strip-types packages/core/src/golden-cli.ts manifest --write
node --experimental-strip-types packages/core/src/golden-cli.ts run --backend openrouter --model <model id>
node --experimental-strip-types packages/core/src/golden-cli.ts compare results/<published>.json <your result>.json
node --experimental-strip-types packages/core/src/golden-cli.ts gate
```

`run --backend openrouter` calls the judge through OpenRouter with the runner's own
`OPENROUTER_API_KEY`. That is the only way to run it: ContextFile runs no public
endpoint that scores an arbitrary claim, so an outside rerun pays for its own model
calls. A run signs its result with `REPORT_SIGNING_KEY_PEM`; without it the result is
signed by a throwaway key and is never shown on /benchmarks.

## Editing the set

Change or add a work file, then run `manifest --write` and commit both. A test fails
the build when the manifest is stale, a digest does not match, a claim cites a source
the work does not have, or a license does not permit publication. Passages and claims
are data: they only ever reach the judge as the text to check.

## Status

The set is published as a pilot: 30 of 220 works, all authored for this set and
released under CC0-1.0, each labeled once (labeler `claude-draft`). The manifest says
`"stage": "pilot"`, and /benchmarks labels the set and every result on it a pilot. A
blind second pass by a separate model labeler agreed on every claim; that is a sanity
check, not inter-labeler agreement, so the set records no second label. One second
labeler, a person, labels the pilot's claims for the agreement score. The remaining
works are operator tasks; set the stage to `full` in `golden-cli.ts` once the set
reaches its target.
