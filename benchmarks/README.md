# ContextFile golden set and accuracy harness

This folder measures the ContextFile verifier's judge against labeled claims and
publishes precision, recall and the misgrounded-citation rate. Anyone can verify and
rerun it from the public repo https://github.com/RepoOps/contextfile-benchmarks, which
`scripts/publish-benchmarks.mjs` writes from this folder and the harness code (see
Publishing below).

## What is here

| Path | What it holds |
| --- | --- |
| `golden-set/works/*.json` | One labeled work per file: its source passages and its claims, each with an expected verdict and its labels. |
| `golden-set/manifest.json` | Set id and version, the target size (220 works), the stage (`pilot` before the set reached its target, `full` since), each work's digest and the set digest. |
| `results/*.json` | Signed results, one per run. |
| `judge-gate.json` | The judge allowed to stand without a result (the one live before the first run). |
| `judge-prompt.json` | The live judge prompt: its version, its hash and the exact text the hash covers. Generated from `packages/core/src/judge.ts`; also served at https://contextfile.ai/benchmarks/judge-prompt.json. |
| `publication.json` | The public harness repo URL. /benchmarks links to it. |
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

The set is full: 220 works and 1,320 claims (660 supported, 331 wrong, 329
misgrounded), all authored for this set and released under CC0-1.0. The manifest says
`"stage": "full"` (version 1.0.0). The first 30 works ran as a pilot from 2026-11-11;
results on that pilot keep their pilot label. Works gw-0031 to gw-0220 were added on
2026-11-18 with the pilot's mix of artifact types and verdicts.

Every claim carries one label (labeler `claude-draft`). A blind second pass by a
separate model labeler agreed on every pilot claim; that is a sanity check, not
inter-labeler agreement, so the set records no second label. One second labeler, a
person, still has to label the claims for the agreement score.

## Publishing

https://github.com/RepoOps/contextfile-benchmarks holds this folder (all but
`publication.json`) and the harness code, with no import of a ContextFile workspace package.
`scripts/publish-benchmarks.mjs` writes that tree; files in `scripts/publish-benchmarks/`
are the parts that are not copies (README, LICENSE, NOTICE, the npm lockfile, the
offline `verify.ts`, a constants reader and the OpenRouter client without the paths for
a customer's own key). To publish a change, write the tree, read it, then commit it to a
clone of the public repo:

```
node --experimental-strip-types scripts/publish-benchmarks.mjs --out <empty folder>
```

`pnpm gates` runs `publish-benchmarks.mjs --check`, which writes the tree to a temp
folder, runs its `verify.ts` and eval checks there, and fails when the tool list
snapshot, the trimmed OpenRouter client or the constants behave differently from the
monorepo code. A change to a harness file that the generator rewrites fails the check
until `REWRITES` in the script is updated.
